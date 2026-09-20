import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { z } from "zod";
import { AssistantResultSchema, EventsServerMessage, LeaseSchema, RegisterInput, TriggerSchema, buildAssistantPrompt, type Trigger, type Lease } from "@kan/protocol";
import { openAgentSession, type AgentCommand } from "./acp-session";
import { HttpError, requestJson, RunClient, validateServerUrl } from "./run-client";
import { AgentRequestError, failure, normalizeFailure, type AgentFailure } from "@kan/protocol";
import { recordRunnerDiagnostic } from "./diagnostics";
import { buildRunnerPrompt } from "./prompt";
import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import type { TOOL_DESCRIPTIONS } from "./tool-descriptions";

type CanvasToolName = keyof typeof TOOL_DESCRIPTIONS;
export interface RunStep { id: string; tool: CanvasToolName | "unknown"; status: ToolCallStatus }

export type ExecutorEvent = { type: "connected" | "disconnected" | "ready" | "run.started" | "run.done" | "run.failed" | "error"; ready?: boolean; runId?: string; failure?: AgentFailure; error?: "agent_unavailable" | "connection_failed" | "claim_failed" };
export interface ExecutorOptions {
  serverUrl: string;
  roomId: string;
  credential: { userId: string; secret: string };
  agent: AgentCommand;
  autoClaim: boolean;
  onEvent?: (event: ExecutorEvent) => void;
  sessionTimeoutMs?: number;
}
export interface RoomExecutor { claim(triggerId: string): Promise<void>; close(): Promise<void> }
const require = createRequire(import.meta.url);
const loader = require.resolve("tsx");
const mcpEntry = fileURLToPath(new URL("./mcp-main.ts", import.meta.url));
const contextSchema = z.object({ trigger: TriggerSchema, causeEntries: z.array(z.unknown()), recentEntries: z.array(z.unknown()), canvas: z.unknown(), revision: z.string().max(128) });

export async function startRoomExecutor(options: ExecutorOptions): Promise<RoomExecutor> {
  if (typeof options.autoClaim !== "boolean") throw new Error("invalid_auto_claim");
  const base = validateServerUrl(options.serverUrl);
  z.uuid().parse(options.roomId);
  RegisterInput.omit({ name: true }).parse(options.credential);
  const timeoutMs = options.sessionTimeoutMs ?? 180_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180_000) throw new Error("invalid_session_timeout");
  const credential = `${options.credential.userId}.${options.credential.secret}`;
  const roomBase = `${base}/rooms/${options.roomId}`;
  const lifetime = new AbortController();
  let ws: WebSocket | undefined;
  let cursor = 0, sessionId = "", connected = false, capable = false, connecting = false;
  let reconnectDelay = 250;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let socketHeartbeat: ReturnType<typeof setInterval> | undefined;
  let active: { controller: AbortController; promise: Promise<void> } | undefined;
  let claiming = false;
  let connectionEpoch = 0;
  let connectionLifetime = new AbortController();
  const pendingClaims = new Set<Promise<void>>();
  const pendingConnections = new Set<Promise<void>>();
  let transportClosed: Promise<void> = Promise.resolve();
  const seen = new Set<string>();
  // Recommended by Norma — fixed with Claude Opus 5 (1M context) via Claude Code
  // A listener that throws must not take the executor down with it, but it also
  // must not vanish: the only reason to be in here is a bug in the consumer.
  const emit = (event: ExecutorEvent) => {
    try { options.onEvent?.(event); } catch (error) { console.error(`kan-runner: onEvent listener threw for "${event.type}"`, error); }
  };
  const readiness = (ready: boolean) => {
    if (connected && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "executor.ready", ready, agentId: "local-acp", scope: options.autoClaim ? "room" : "manual", background: options.autoClaim }));
    emit({ type: "ready", ready });
  };
  async function preflight(signal = lifetime.signal) {
    try {
      const session = await openAgentSession(options.agent, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      await session.close(); capable = true; return true;
    } catch { capable = false; readiness(false); emit({ type: "error", error: "agent_unavailable" }); return false; }
  }
  async function execute(lease: Lease, controller: AbortController) {
    const signal = controller.signal;
    const run = new RunClient(base, options.roomId, lease.runId, lease.leaseToken, signal);
    let agent: Awaited<ReturnType<typeof openAgentSession>> | undefined;
    let stopWrites = false, terminal = false, dirty = false, text = "";
    let phase = "context";
    let rootFailure: AgentFailure | undefined;
    const steps: RunStep[] = [];
    const stepIndexes = new Map<string, number>();
    let writing: Promise<unknown> = Promise.resolve();
    let writeBusy = false;
    let deadline: ReturnType<typeof setTimeout>;
    const expire = (at: number) => { clearTimeout(deadline); deadline = setTimeout(() => { stopWrites = true; rootFailure = failure("LEASE_EXPIRED", "heartbeat", "unknown"); controller.abort(new AgentRequestError(rootFailure)); }, Math.max(0, at - Date.now())); };
    expire(lease.expiresAt);
    const sessionTimer = setTimeout(() => { rootFailure = failure("AGENT_TIMEOUT", "agent", "unknown"); controller.abort(new AgentRequestError(rootFailure)); }, timeoutMs);
    const heartbeat = setInterval(() => {
      void run.request<{ expiresAt: number }>("/heartbeat", "POST", undefined, false).then((response) => expire(response.expiresAt)).catch((error) => { stopWrites = true; rootFailure = { ...normalizeFailure(error, "heartbeat"), phase: "heartbeat" }; controller.abort(new AgentRequestError(rootFailure)); });
    }, 10_000);
    const stream = setInterval(() => {
      if (!dirty || signal.aborted || writeBusy) return;
      dirty = false; writeBusy = true;
      const snapshot = { id: randomUUID(), text, steps: [...steps] };
      writing = run.request("", "PATCH", snapshot).catch((error) => { stopWrites = true; rootFailure = { ...normalizeFailure(error, "stream"), phase: "stream" }; controller.abort(new AgentRequestError(rootFailure)); }).finally(() => { writeBusy = false; });
    }, 250);
    emit({ type: "run.started", runId: lease.runId });
    try {
      const context = contextSchema.parse(await run.request("/context"));
      const contextual = context.trigger.mode !== "act";
      const tools: CanvasToolName[] = context.trigger.mode === "act" ? ["getCanvas", "queryData", "addNode", "updateNode", "connectNodes", "arrange"] : ["getCanvas", "queryData", "proposeNode"];
      phase = "initialize";
      agent = await openAgentSession(options.agent, {
        signal, runId: lease.runId,
        allowedTools: contextual ? [] : tools,
        mcpServers: contextual ? [] : [{ name: "kan-canvas", command: process.execPath, args: ["--import", loader, mcpEntry], env: [
          { name: "KAN_RUN_SERVER_URL", value: base }, { name: "KAN_RUN_ROOM_ID", value: options.roomId }, { name: "KAN_RUN_RUN_ID", value: lease.runId }, { name: "KAN_RUN_LEASE_TOKEN", value: lease.leaseToken },
        ] }],
        onUpdate: ({ update }) => {
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") { text = (text + update.content.text).slice(0, 50_000); dirty = !contextual; }
          if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            const rawId = update.toolCallId;
            const id = /^[A-Za-z0-9_.:-]{1,128}$/.test(rawId) && !/^call_[0-9a-f]{64}$/.test(rawId)
              ? rawId : `call_${createHash("sha256").update(rawId).digest("hex")}`;
            const index = stepIndexes.get(id);
            if (index === undefined && steps.length >= 200) return;
            const previous = index === undefined ? undefined : steps[index];
            const tool = update.name == null ? previous?.tool ?? "unknown"
              : tools.find((name) => update.name === name || update.name === `mcp__kan-canvas__${name}`) ?? "unknown";
            const step: RunStep = { id, tool, status: update.status ?? previous?.status ?? "pending" };
            if (index === undefined) { stepIndexes.set(id, steps.length); steps.push(step); }
            else steps[index] = step;
            dirty = true;
          }
        },
      });
      phase = "agent";
      const response = await agent.prompt(contextual ? buildAssistantPrompt("context", context) : buildRunnerPrompt(context));
      signal.throwIfAborted();
      clearInterval(stream); await writing;
      signal.throwIfAborted();
      if (contextual) {
        if (response.stopReason !== "end_turn") throw new AgentRequestError(failure("TURN_INCOMPLETE", "agent", "not_applied"));
        phase = "parse";
        const result = AssistantResultSchema.parse(JSON.parse(text));
        phase = "complete";
        await run.request("/complete", "POST", { id: randomUUID(), revision: context.revision, result });
        terminal = true;
        emit({ type: "run.done", runId: lease.runId });
      } else {
        const status = response.stopReason === "end_turn" ? "done" : "failed";
        phase = "complete";
        if (status === "failed") recordRunnerDiagnostic({ event: "prompt.incomplete", runId: lease.runId, failure: failure("TURN_INCOMPLETE", "agent", "unknown") });
        await run.request("", "PATCH", { id: randomUUID(), text, steps, status });
        terminal = true;
        emit({ type: status === "done" ? "run.done" : "run.failed", runId: lease.runId });
      }
    } catch (cause) {
      const detail = rootFailure ?? (phase === "parse" ? failure("STRUCTURED_OUTPUT_INVALID", phase, "not_applied") : normalizeFailure(cause, phase));
      recordRunnerDiagnostic({ event: "run.failed", runId: lease.runId, phase, failure: detail });
      if (!agent) { capable = false; readiness(false); }
      if (!terminal && !stopWrites) {
        terminal = true;
        try { await new RunClient(base, options.roomId, lease.runId, lease.leaseToken).request("", "PATCH", { id: randomUUID(), text, steps, status: "failed" }); }
        catch (error) { recordRunnerDiagnostic({ event: "run.report_failed", runId: lease.runId, phase: "report", failure: normalizeFailure(error, "report") }); }
      }
      emit({ type: "run.failed", runId: lease.runId, failure: detail });
    } finally {
      clearInterval(stream); clearInterval(heartbeat); clearTimeout(sessionTimer); clearTimeout(deadline!);
      controller.abort();
      await writing;
      await agent?.close();
    }
  }
  function claim(triggerId: string, manual = true): Promise<void> {
    const task = claimInner(triggerId, manual);
    pendingClaims.add(task);
    void task.finally(() => pendingClaims.delete(task)).catch(() => {});
    return task;
  }
  async function claimInner(triggerId: string, manual: boolean) {
    z.uuid().parse(triggerId);
    if (lifetime.signal.aborted || !connected || active || claiming) throw new Error("executor_busy_or_offline");
    const epoch = connectionEpoch;
    const claimSignal = AbortSignal.any([lifetime.signal, connectionLifetime.signal]);
    const stillConnected = () => { claimSignal.throwIfAborted(); if (!connected || epoch !== connectionEpoch) throw new Error("connection_lost"); };
    claiming = true;
    try {
      if (!capable && !await preflight(claimSignal)) throw new Error("agent_unavailable");
      stillConnected();
      if (manual) {
        await new Promise<void>((resolve, reject) => {
          const socket = ws!;
          const cleanup = () => { clearTimeout(timer); socket.off("message", listener); claimSignal.removeEventListener("abort", abort); };
          const abort = () => { cleanup(); reject(new Error("connection_lost")); };
          const timer = setTimeout(() => { cleanup(); reject(new Error("readiness_timeout")); }, 5000);
          const listener = (data: WebSocket.RawData) => {
            try {
              const parsed = EventsServerMessage.safeParse(JSON.parse(String(data)));
              if (parsed.success && parsed.data.type === "presence" && parsed.data.executors.some((e) => e.sessionId === sessionId && e.ready)) { cleanup(); resolve(); }
            } catch { abort(); }
          };
          socket.on("message", listener);
          claimSignal.addEventListener("abort", abort, { once: true });
          if (claimSignal.aborted) abort(); else readiness(true);
        });
      }
      stillConnected();
      const result = await requestJson<{ lease: unknown }>(`${roomBase}/triggers/${triggerId}/claim`, credential, "POST", { sessionId, manual }, false);
      const lease = LeaseSchema.parse(result.lease);
      seen.add(`${triggerId}:${lease.attempt - 1}`);
      try { stillConnected(); } catch (error) {
        try { await new RunClient(base, options.roomId, lease.runId, lease.leaseToken).request("", "PATCH", { id: randomUUID(), status: "failed" }); } catch {}
        throw error;
      }
      const controller = new AbortController();
      const abort = () => controller.abort(); claimSignal.addEventListener("abort", abort, { once: true });
      const promise = execute(lease, controller).finally(() => { claimSignal.removeEventListener("abort", abort); active = undefined; if (!lifetime.signal.aborted) readiness(options.autoClaim && capable); });
      active = { controller, promise };
    } catch (error) {
      emit({ type: "error", error: "claim_failed" });
      if (!(error instanceof HttpError && error.status === 409)) throw new Error("claim_failed");
    } finally { claiming = false; if (!options.autoClaim) readiness(false); }
  }
  function offer(trigger: Trigger) {
    if (options.autoClaim && capable && !active && !claiming && !seen.has(`${trigger.id}:${trigger.attempt}`) && trigger.status === "offered" && trigger.assigneeSessionId === sessionId) void claim(trigger.id, false).catch(() => {});
  }
  function connect(): Promise<void> {
    const task = connectInner();
    pendingConnections.add(task);
    void task.finally(() => pendingConnections.delete(task)).catch(() => {});
    return task;
  }
  async function connectInner() {
    if (lifetime.signal.aborted || connecting) return;
    connecting = true;
    try {
      const ticket = await requestJson<{ ticket: string }>(`${roomBase}/socket-ticket`, credential, "POST", { channel: "events" }, false, lifetime.signal);
      if (lifetime.signal.aborted) return;
      const url = new URL(`${base.replace(/^http/, "ws")}/events/${options.roomId}`); url.searchParams.set("ticket", ticket.ticket); url.searchParams.set("since", String(cursor));
      connectionLifetime = new AbortController();
      connectionEpoch++;
      const socket = new WebSocket(url, { handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024 }); ws = socket;
      transportClosed = new Promise<void>((resolve) => socket.once("close", resolve));
      const readyTimeout = setTimeout(() => socket.terminate(), 5000);
      socket.on("error", () => {});
      socket.on("message", (data) => {
        try {
          const msg = EventsServerMessage.parse(JSON.parse(String(data)));
          if (msg.type === "event") { cursor = msg.event.cursor; if (connected && msg.event.entry.kind === "trigger") offer(msg.event.entry.trigger); }
          if (msg.type === "ready") {
            clearTimeout(readyTimeout);
            cursor = msg.cursor; sessionId = msg.sessionId; connected = true; reconnectDelay = 250;
            emit({ type: "connected" }); readiness(options.autoClaim && capable);
            for (const trigger of msg.triggers) offer(trigger);
            socketHeartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "heartbeat" })); }, 10_000);
          }
        } catch { socket.close(4400, "invalid server message"); }
      });
      socket.once("close", () => {
        clearTimeout(readyTimeout);
        connected = false; connectionLifetime.abort(); clearInterval(socketHeartbeat); active?.controller.abort(); emit({ type: "disconnected" });
        if (!lifetime.signal.aborted) { reconnectTimer = setTimeout(() => { void connect(); }, reconnectDelay); reconnectDelay = Math.min(5000, reconnectDelay * 2); }
      });
    } catch {
      emit({ type: "error", error: "connection_failed" });
      if (!lifetime.signal.aborted) { reconnectTimer = setTimeout(() => { void connect(); }, reconnectDelay); reconnectDelay = Math.min(5000, reconnectDelay * 2); }
    } finally { connecting = false; }
  }
  if (options.autoClaim) await preflight();
  await connect();
  return {
    claim: (id) => claim(id),
    close: async () => { lifetime.abort(); connectionLifetime.abort(); clearTimeout(reconnectTimer); clearInterval(socketHeartbeat); ws?.terminate(); await Promise.allSettled([...pendingClaims, ...pendingConnections]); await active?.promise; await transportClosed; },
  };
}
