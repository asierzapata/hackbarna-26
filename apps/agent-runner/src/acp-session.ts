import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, ndJsonStream, PROTOCOL_VERSION, type McpServer, type SessionNotification, type RequestPermissionRequest } from "@agentclientprotocol/sdk";

export interface AgentCommand { command: string; args: string[] }
export function safeEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "LANG"]) if (env[key]) safe[key] = env[key]!;
  return safe;
}
export function permissionResult(request: RequestPermissionRequest, allowed: Set<string>) {
  const name = request.toolCall.name;
  if (typeof name === "string" && allowed.has(name)) {
    const option = request.options.find((o) => o.kind === "allow_once");
    if (option) return { outcome: { outcome: "selected" as const, optionId: option.optionId } };
  }
  const reject = request.options.find((o) => o.kind === "reject_once");
  return reject ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } } : { outcome: { outcome: "cancelled" as const } };
}

export async function openAgentSession(agent: AgentCommand, options: { signal: AbortSignal; mcpServers?: McpServer[]; allowedTools?: string[]; onUpdate?: (notification: SessionNotification) => void }) {
  if (!agent.command || !Array.isArray(agent.args) || agent.args.some((arg) => typeof arg !== "string")) throw new Error("invalid_agent_command");
  const cwd = await mkdtemp(join(tmpdir(), "kan-agent-"));
  const child = spawn(agent.command, agent.args, { cwd, shell: false, detached: process.platform !== "win32", env: safeEnvironment(), stdio: ["pipe", "pipe", "ignore"] });
  let exited = false;
  const exit = new Promise<void>((resolve) => { child.once("exit", () => { exited = true; resolve(); }); child.once("error", () => { exited = true; resolve(); }); });
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {}
  };
  const denied = () => { throw new Error("permission_denied"); };
  const allowed = new Set((options.allowedTools ?? []).map((name) => `mcp__kan-canvas__${name}`));
  const app = client()
    .onRequest("session/request_permission", ({ params }) => permissionResult(params, allowed))
    .onRequest("fs/read_text_file", denied)
    .onRequest("fs/write_text_file", denied)
    .onRequest("terminal/create", denied)
    .onRequest("terminal/output", denied)
    .onRequest("terminal/release", denied)
    .onRequest("terminal/wait_for_exit", denied)
    .onRequest("terminal/kill", denied)
    .onNotification("session/update", ({ params }) => { if (!options.signal.aborted) options.onUpdate?.(params); });
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
  let abortKillTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    connection.close(); kill("SIGTERM");
    abortKillTimer = setTimeout(() => kill("SIGKILL"), 500);
    abortKillTimer.unref();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  let closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    options.signal.removeEventListener("abort", abort);
    clearTimeout(abortKillTimer);
    connection.close(); kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); })]);
    clearTimeout(timer);
    kill("SIGKILL");
    if (!exited) await exit;
    await rm(cwd, { recursive: true, force: true });
  })();
  try {
    options.signal.throwIfAborted();
    const requestOptions = { cancellationSignal: options.signal };
    await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "kan-room-executor", version: "0.1.0" } }, requestOptions);
    const session = await connection.agent.request("session/new", { cwd, mcpServers: options.mcpServers ?? [] }, requestOptions);
    if (!session.sessionId) throw new Error("agent_unavailable");
    return { close, prompt: (text: string) => connection.agent.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text }] }, requestOptions) };
  } catch {
    await close();
    throw new Error("agent_unavailable");
  }
}
