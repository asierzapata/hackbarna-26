#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const sessions = new Map();
const permissions = new Map();
const children = new Set();
let sequence = 10000;
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
const text = (sessionId, value) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
function permission(sessionId, name, toolCallId) {
  const id = sequence++;
  return new Promise((resolve) => {
    permissions.set(id, resolve);
    send({ id, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId, name }, options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }, { optionId: "no", kind: "reject_once", name: "Reject" }] } });
  });
}
async function connect(config) {
  const child = spawn(config.command, config.args, { env: { ...process.env, ...Object.fromEntries(config.env.map(({ name, value }) => [name, value])) }, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  child.stderr.resume();
  const pending = new Map();
  child.once("exit", () => { children.delete(child); for (const { reject } of pending.values()) reject(new Error("MCP child exited")); });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error("MCP protocol error")) : waiter.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = sequence++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "diagnostics-fixture", version: "1" } });
  await request("tools/list", {});
  return request;
}
async function prompt(message) {
  const { sessionId } = message.params;
  const session = sessions.get(sessionId);
  const source = message.params.prompt.map((part) => part.text ?? "").join("\n");
  const scenario = source.match(/\[diag:([a-z-]+)\]/)?.[1] ?? "structured";
  if (scenario === "exit") { process.stderr.write("fixture provider exited unexpectedly\nBearer fixture-secret-never-export\n"); process.exit(23); }
  if (scenario === "malformed") process.stdout.write("fixture invalid protocol line\n");
  if (scenario === "incomplete") { send({ id: message.id, result: { stopReason: "max_tokens" } }); return; }
  if (scenario === "structured") { text(sessionId, "{not valid structured output"); send({ id: message.id, result: { stopReason: "end_turn" } }); return; }
  const tool = async (name, args) => {
    const toolCallId = randomUUID();
    const wireName = name === "terminal" ? "terminal" : `mcp__kan-canvas__${name}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, name: wireName, title: name, kind: "other", status: "pending" });
    const allowed = await permission(sessionId, wireName, toolCallId);
    if (allowed.outcome?.optionId !== "yes") {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      return { isError: true, content: [{ text: '{"code":"PERMISSION_DENIED"}' }] };
    }
    session.mcp ??= connect(session.config);
    const request = await session.mcp;
    const result = await request("tools/call", { name, arguments: args });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: result.isError ? "failed" : "completed", content: result.content });
    return result;
  };
  let result;
  if (scenario === "invalid") result = await tool("addNode", { requestId: randomUUID(), draft: { type: "calendar", title: "Invalid fixture", events: [{ id: "bad", title: "Invalid date", start: "2026-02-30" }] } });
  else if (scenario === "permission") result = await tool("terminal", {});
  else if (scenario === "mermaid") result = await tool("addMermaidDiagram", { requestId: randomUUID(), source: "flowchart LR\n A[Deadline] --> B[Guard]" });
  else if (["timeout", "oversized", "delivery"].includes(scenario)) result = await tool("getCanvas", { scope: "full" });
  else {
    const args = { requestId: randomUUID(), draft: { type: "geo", geo: "rectangle", text: "Diagnostic fixture", w: 220, h: 100 } };
    result = await tool("addNode", args);
    if (scenario === "duplicate") result = await tool("addNode", args);
    if (scenario === "conflict") result = await tool("addNode", { ...args, draft: { ...args.draft, text: "Conflicting retry" } });
    if (scenario === "partial") result = await tool("updateNode", { requestId: randomUUID(), shapeId: "shape:missing-diagnostic-fixture", patch: { type: "geo", text: "Missing" } });
  }
  text(sessionId, result?.isError ? `Fixture ${scenario}: ${JSON.parse(result.content[0].text).code}` : `Fixture ${scenario}: completed`);
  send({ id: message.id, result: { stopReason: "end_turn" } });
}
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (!message.method) { permissions.get(message.id)?.(message.result); permissions.delete(message.id); return; }
  try {
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "diagnostics-fixture", title: "Diagnostics fixture" }, agentCapabilities: {}, authMethods: [] } });
    else if (message.method === "session/new") { const sessionId = randomUUID(); sessions.set(sessionId, { config: message.params.mcpServers?.[0] }); send({ id: message.id, result: { sessionId } }); }
    else if (message.method === "session/prompt") await prompt(message);
    else if (message.id !== undefined) send({ id: message.id, result: {} });
  } catch { send({ id: message.id, error: { code: -32603, message: "diagnostics fixture failed" } }); }
});
process.once("exit", () => { for (const child of children) child.kill(); });
process.stdin.once("end", () => process.exit(0));
