/**
 * The agent runner, seen from the webview.
 *
 * The ACP client itself lives in Rust (`src-tauri/src/agent.rs`); this is the
 * thin side: three commands and one event stream. Nothing here knows about the
 * protocol beyond the shape of a `session/update`, or about the difference
 * between the providers beyond their names.
 *
 * Connecting is deliberately lazy — no agent process is spawned until someone
 * signs in from the header. Exactly one provider is connected at a time.
 */
import * as React from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { canvasToolDefinitions } from "@/lib/canvas-agent";
import { canvasThinkingTargets } from "@/lib/agent-thinking";
import { applyToolCall, thoughtLine } from "@/lib/agent-steps";
import type { AgentStep } from "@/lib/thread";
import { buildAssistantPrompt, directCanvasResult, type AssistantResult } from "@kan/protocol";
import { parseStructuredOutput } from "@/lib/assistant-controller";
import { useQaSource } from "@/lib/qa-source";
import { AgentRequestError, failure, normalizeFailure, type AgentFailure } from "@kan/protocol";
import { captureFailureDetails, getDiagnostics, recordDiagnostic, refreshDiagnostics, startDiagnostics } from "@/lib/agent-diagnostics";
import { executeInstrumentedTool } from "@/lib/tool-execution";

/** Providers, keyed the way the Rust side deserializes them. */
export type Provider = "devin" | "openai";

/** Which credentials to sign in with. */
export type AuthMode = "subscription" | "api_key";

export const providerLabels: Record<Provider, string> = {
  devin: "Devin",
  openai: "OpenAI",
};

export type AgentState = "idle" | "connecting" | "ready" | "unavailable";

export interface AgentStatus {
  state: AgentState;
  provider?: Provider | null;
  providerLabel?: string | null;
  agent?: string | null;
  message?: string | null;
  mode?: AuthMode | null;
  models?: { available: { id: string; label: string }[]; current: string | null };
}

export interface AgentPreferences {
  provider: Provider | null;
  mode: AuthMode | null;
  modelId: string | null;
  autoConnect: boolean;
}

/** The subset of ACP session updates the thread renders. */
type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content?: { text?: string } }
  | { sessionUpdate: "agent_thought_chunk"; content?: { text?: string } }
  | { sessionUpdate: "tool_call"; toolCallId: string; title?: string; kind?: string; status?: string }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; title?: string; kind?: string; status?: string }
  | { sessionUpdate: string };

/**
 * What the current turn is doing, for the thread to render.
 *
 * Client-only and deliberately not part of any entry: the room owns entries,
 * and this is gone the moment the turn ends. `turnId` is here so a consumer
 * can tell whose activity this is rather than painting it onto the wrong run.
 */
export interface AgentActivityState {
  turnId: string | null;
  steps: AgentStep[];
  /** Everything streamed so far, kept whole so the line does not flash tokens. */
  thoughtBuffer?: string;
  /** What the thread shows: the last finished sentence of the buffer. */
  thought?: string;
}

const idleActivity: AgentActivityState = { turnId: null, steps: [] };

/** A tool call as the thread wants it: `kind` and `title` may arrive apart. */
export interface AgentToolCall {
  id: string;
  title?: string;
  kind?: string;
  /** ACP status: `pending` | `in_progress` | `completed` | `failed`. */
  status: string;
}

export interface PromptHandlers {
  /** A chunk of the agent's reply. Append, don't replace. */
  onText?: (text: string) => void;
  onTool?: (call: AgentToolCall) => void;
  onTrace?: (turnId: string) => void;
  canvas?: { id: string; shapeIds?: string[]; execute: (name: string, input: unknown, assertActive?: () => void) => unknown | Promise<unknown> };
}

interface CanvasToolRequest {
  requestId: string;
  turnId: string;
  canvasId: string;
  name: string;
  arguments: unknown;
  expiresAt: number;
}

interface AgentApi {
  status: AgentStatus;
  preferences: AgentPreferences | null;
  setModel: (modelId: string) => Promise<void>;
  /**
   * Start a provider and open a session with the chosen credentials. The key is
   * only read for `api_key` mode and is never persisted — on either side.
   */
  signIn: (
    provider: Provider,
    mode: AuthMode,
    apiKey?: string
  ) => Promise<void>;
  /** Stop the agent. Stored subscription credentials are untouched. */
  signOut: () => Promise<void>;
  /** One prompt turn. Resolves when the turn ends. */
  prompt: (text: string, handlers: PromptHandlers) => Promise<void>;
  /**
   * One structured turn against a claimed trigger. `shapeIds` are the nodes
   * the trigger anchored on, so the canvas shows what Kan is looking at for
   * the same reason a tool-driven turn does.
   */
  runStructured: (
    mode: "act" | "context" | "propose",
    context: unknown,
    signal: AbortSignal,
    shapeIds?: string[],
    runId?: string
  ) => Promise<AssistantResult>;
  busy: boolean;
  /** Live tool calls and reasoning for the turn in flight. */
  activity: AgentActivityState;
  thinkingShapeIds: string[];
  cancel: () => Promise<void>;
}

const AgentContext = React.createContext<AgentApi | null>(null);

export function AgentProvider({ children, canvasId }: { children: React.ReactNode; canvasId?: string }) {
  const [status, setStatus] = React.useState<AgentStatus>(() =>
    isTauri()
      ? { state: "idle" }
      : // The browser dev server has no Tauri IPC, so there is nothing to talk to.
        { state: "unavailable", message: "Only available in the desktop app" }
  );
  const [busy, setBusy] = React.useState(false);
  const [preferences, setPreferences] = React.useState<AgentPreferences | null>(null);
  const generation = React.useRef(0);
  const [thinkingShapeIds, setThinkingShapeIds] = React.useState<string[]>([]);
  const [activity, setActivity] = React.useState<AgentActivityState>(idleActivity);
  useQaSource("agent", () => ({
    state: status.state, provider: status.provider, model: status.models?.current,
    message: status.message, busy, thinkingShapeIds, diagnostics: getDiagnostics(),
  }));

  // One listener for the whole app; the in-flight prompt claims it.
  const handlers = React.useRef<PromptHandlers | null>(null);
  const turnId = React.useRef<string | null>(null);
  const listenersReady = React.useRef<Promise<unknown>>(Promise.resolve());
  const toolRequests = React.useRef(new Set<string>());
  const deliveryFailure = React.useRef<AgentFailure | null>(null);
  const cancelledTurn = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;
    setThinkingShapeIds([]);
    setActivity(idleActivity);
    setBusy(false);
    const request = ++generation.current;
    setStatus({ state: "connecting" });
    void invoke<AgentPreferences>("agent_preferences").then((saved) => {
      if (mounted) setPreferences(saved);
    }).catch(() => {});
    void invoke<AgentStatus>("agent_restore", { canvasId, tools: canvasToolDefinitions }).then((remote) => {
      if (mounted && request === generation.current) setStatus(remote);
    }).catch((error) => {
      if (mounted && request === generation.current) setStatus({ state: "idle", message: String(error) });
    });

    const updates = listen<{ turnId: string; update: SessionUpdate }>("agent:update", ({ payload: envelope }) => {
      // A structured turn has no handlers — its answer is the command's
      // return value — but it still reports activity, and that is the whole
      // point of the rail. So the turn id is the gate, not the handlers.
      const active = handlers.current;
      if (envelope.turnId !== turnId.current) return;
      const payload = envelope.update;

      switch (payload.sessionUpdate) {
        case "agent_message_chunk": {
          const text = (payload as { content?: { text?: string } }).content?.text;
          if (text) active?.onText?.(text);
          break;
        }
        case "agent_thought_chunk": {
          const text = (payload as { content?: { text?: string } }).content?.text;
          if (!text) break;
          // Accumulate, then show one finished sentence at a time. A side panel
          // has no room for a full thought log, and nobody reads one anyway.
          setActivity((previous) => {
            if (previous.turnId !== envelope.turnId) return previous;
            const thoughtBuffer = (previous.thoughtBuffer ?? "") + text;
            return { ...previous, thoughtBuffer, thought: thoughtLine(thoughtBuffer) };
          });
          break;
        }
        case "tool_call":
        case "tool_call_update": {
          const call = payload as Omit<AgentToolCall, "id" | "status"> & {
            toolCallId: string;
            status?: string;
          };
          const update: AgentToolCall = {
            id: call.toolCallId,
            title: call.title,
            kind: call.kind,
            status: call.status ?? "pending",
          };
          active?.onTool?.(update);
          setActivity((previous) =>
            previous.turnId === envelope.turnId
              ? { ...previous, steps: applyToolCall(previous.steps, update, performance.now()) }
              : previous
          );
          break;
        }
      }
    });

    const canvas = listen<CanvasToolRequest>("canvas:tool", async ({ payload }) => {
      const active = handlers.current?.canvas;
      if (!mounted || !active || payload.turnId !== turnId.current || payload.canvasId !== active.id) {
        recordDiagnostic({ event: "tool.stale_event", turnId: payload.turnId, requestId: payload.requestId, tool: payload.name, failure: failure("STALE_TURN", "delivery", "not_applied") });
        return;
      }
      if (toolRequests.current.has(payload.requestId)) return;
      toolRequests.current.add(payload.requestId);
      try {
        await executeInstrumentedTool(payload, {
          active: () => mounted && handlers.current?.canvas === active && payload.turnId === turnId.current && cancelledTurn.current !== payload.turnId,
          execute: async (name, input, assertActive) => {
            try { return await active.execute(name, input, assertActive); }
            catch (error) { captureFailureDetails(payload.turnId, error); throw error; }
          },
          deliver: (value) => invoke("agent_canvas_result", value),
          record: recordDiagnostic,
          onResult: (result) => {
            const targets = canvasThinkingTargets(payload.name, payload.arguments, result);
            if (targets) setThinkingShapeIds(targets);
          },
        });
      } catch (error) {
        if (payload.turnId !== turnId.current) return;
        deliveryFailure.current = normalizeFailure(error, "delivery");
        setStatus((previous) => ({ ...previous, message: deliveryFailure.current!.message }));
        void invoke("agent_cancel", { turnId: payload.turnId }).catch((cause) => recordDiagnostic({ event: "prompt.cancel_failed", turnId: payload.turnId, failure: normalizeFailure(cause, "cancel") }));
      }
    });

    const closed = listen("agent:closed", () => {
      handlers.current = null;
      turnId.current = null;
      setBusy(false);
      setThinkingShapeIds([]);
      setActivity(idleActivity);
      // Losing a live connection is worth reporting; following our own
      // sign-out (which already reset the status) is not.
      setStatus((prev) =>
        prev.state === "ready"
          ? { state: "idle", message: "The agent stopped" }
          : { state: "idle" }
      );
    });

    listenersReady.current = Promise.all([updates, closed, canvas, startDiagnostics()]);
    return () => {
      mounted = false;
      ++generation.current;
      const activeId = turnId.current;
      turnId.current = null;
      handlers.current = null;
      if (activeId) void invoke("agent_cancel", { turnId: activeId });
      void updates.then((un) => un());
      void closed.then((un) => un());
      void canvas.then((un) => un());
    };
  }, [canvasId]);

  const api: AgentApi = {
    status,
    busy,
    activity,
    thinkingShapeIds,
    preferences,
    setModel: async (modelId) => {
      setBusy(true);
      try {
        setStatus(await invoke<AgentStatus>("agent_set_model", { modelId }));
        setPreferences(await invoke<AgentPreferences>("agent_preferences"));
      } catch (error) {
        const remote = await invoke<AgentStatus>("agent_status", { canvasId }).catch(() => status);
        setStatus({ ...remote, message: String(error) });
      } finally {
        setBusy(false);
      }
    },
    signIn: async (provider, mode, apiKey) => {
      const request = ++generation.current;
      setStatus({ state: "connecting", provider, providerLabel: providerLabels[provider] });
      try {
        const remote = await invoke<AgentStatus>("agent_sign_in", { provider, mode, apiKey, tools: canvasToolDefinitions, canvasId });
        if (request === generation.current) {
          setStatus(remote);
          setPreferences(await invoke<AgentPreferences>("agent_preferences"));
        }
      } catch (error) {
        if (request === generation.current) setStatus({ state: "unavailable", provider, message: String(error) });
      }
    },
    signOut: async () => {
      setThinkingShapeIds([]);
      setActivity(idleActivity);
      handlers.current = null;
      ++generation.current;
      setStatus({ state: "connecting" });
      try {
        await invoke("agent_sign_out");
        setStatus({ state: "idle" });
        setPreferences(await invoke<AgentPreferences>("agent_preferences"));
      } catch (error) {
        setStatus({ state: "idle", message: String(error) });
      }
    },
    cancel: async () => {
      const activeId = turnId.current;
      cancelledTurn.current = activeId;
      handlers.current = null;
      setThinkingShapeIds([]);
      setActivity(idleActivity);
      if (activeId) await invoke("agent_cancel", { turnId: activeId });
    },
    prompt: async (text, next) => {
      if (turnId.current) throw new Error("An agent turn is already running");
      const id = crypto.randomUUID();
      turnId.current = id;
      toolRequests.current.clear();
      deliveryFailure.current = null;
      cancelledTurn.current = null;
      const startedAt = performance.now();
      next.onTrace?.(id);
      setActivity({ turnId: id, steps: [] });
      recordDiagnostic({ event: "prompt.started", turnId: id, provider: status.provider ?? undefined, model: status.models?.current ?? undefined, phase: "tools" });
      handlers.current = next;
      setThinkingShapeIds(next.canvas?.shapeIds ?? []);
      setBusy(true);
      try {
        await listenersReady.current;
        if (turnId.current !== id || !handlers.current) throw new Error("Agent turn cancelled");
        const stop = await invoke<string>("agent_prompt", { text, turnId: id, canvasId: next.canvas?.id });
        if (deliveryFailure.current) throw new AgentRequestError(deliveryFailure.current);
        if (cancelledTurn.current === id || stop === "cancelled") throw new AgentRequestError(failure("CANCELLED", "agent", "unknown"));
        if (stop !== "end_turn") throw new AgentRequestError(failure("TURN_INCOMPLETE", "agent", "unknown"));
        await refreshDiagnostics(id).catch(() => undefined);
        const toolErrors = getDiagnostics(id).events.some((event) => !!event.failure && event.event.startsWith("tool."));
        recordDiagnostic({ event: toolErrors ? "prompt.completed_with_tool_errors" : "prompt.completed", turnId: id, durationMs: performance.now() - startedAt });
      } catch (cause) {
        const error = deliveryFailure.current ?? (cancelledTurn.current === id ? failure("CANCELLED", "agent", "unknown") : normalizeFailure(cause, "agent"));
        captureFailureDetails(id, cause);
        recordDiagnostic({ event: error.code === "CANCELLED" ? "prompt.cancelled" : "prompt.failed", turnId: id, durationMs: performance.now() - startedAt, failure: error });
        throw new AgentRequestError(error, { cause });
      } finally {
        if (turnId.current === id) {
          turnId.current = null;
          handlers.current = null;
          setThinkingShapeIds([]);
          setActivity(idleActivity);
          setBusy(false);
        }
      }
    },
    runStructured: async (mode, context, signal, shapeIds, runId) => {
      if (signal.aborted) throw new DOMException("assistant turn cancelled", "AbortError");
      if (turnId.current) throw new Error("An agent turn is already running");
      const direct = directCanvasResult(mode, context);
      const id = runId ?? crypto.randomUUID();
      turnId.current = id;
      setActivity({ turnId: id, steps: [] });
      setThinkingShapeIds(shapeIds ?? []);
      setBusy(true);
      let abortHandler: (() => void) | undefined;
      const startedAt = performance.now();
      recordDiagnostic({ event: "prompt.started", turnId: id, provider: status.provider ?? undefined, model: status.models?.current ?? undefined, phase: direct ? "direct" : "structured" });
      try {
        if (direct) {
          recordDiagnostic({ event: "prompt.completed", turnId: id, durationMs: performance.now() - startedAt, phase: "direct" });
          return direct;
        }
        await listenersReady.current;
        if (signal.aborted || turnId.current !== id) throw new DOMException("assistant turn cancelled", "AbortError");
        const abortPromise = new Promise<never>((_, reject) => {
          abortHandler = () => {
            void invoke("agent_cancel", { turnId: id }).catch(() => {});
            reject(new DOMException("assistant turn cancelled", "AbortError"));
          };
          signal.addEventListener("abort", abortHandler, { once: true });
        });
        const invokePromise = invoke<string>("agent_prompt_structured", { prompt: buildAssistantPrompt(mode, context), turnId: id });
        const raw = await Promise.race([invokePromise, abortPromise]);
        if (signal.aborted) throw new DOMException("assistant turn cancelled", "AbortError");
        let result: AssistantResult;
        try { result = parseStructuredOutput(raw); }
        catch (error) { captureFailureDetails(id, error); throw new AgentRequestError(failure("STRUCTURED_OUTPUT_INVALID", "parse", "not_applied", { issues: normalizeFailure(error, "parse").issues }), { cause: error }); }
        if ((mode === "context" || mode === "propose") && result.kind === "act") throw new Error("contextual assistant turns cannot act");
        recordDiagnostic({ event: "prompt.completed", turnId: id, durationMs: performance.now() - startedAt });
        return result;
      } catch (cause) {
        const error = normalizeFailure(cause, "structured");
        recordDiagnostic({ event: error.code === "CANCELLED" ? "prompt.cancelled" : "prompt.failed", turnId: id, durationMs: performance.now() - startedAt, failure: error });
        if (error.code === "CANCELLED") throw new DOMException(error.message, "AbortError");
        throw new AgentRequestError(error, { cause });
      } finally {
        if (abortHandler) signal.removeEventListener("abort", abortHandler);
        if (turnId.current === id) {
          turnId.current = null;
          setThinkingShapeIds([]);
          setActivity(idleActivity);
          setBusy(false);
        }
      }
    },
  };

  return <AgentContext.Provider value={api}>{children}</AgentContext.Provider>;
}

export function useAgent() {
  const api = React.useContext(AgentContext);
  if (!api) throw new Error("useAgent must be used inside <AgentProvider>");
  return api;
}
