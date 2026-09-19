import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { api, createRoom, registerUser, setup, ticket, EventsClient, sleep } from "../../room-server/test/helpers";
import { startRoomExecutor, type ExecutorEvent } from "../src/executor";
import { permissionResult, safeEnvironment } from "../src/acp-session";
import { validateServerUrl } from "../src/run-client";

const require = createRequire(import.meta.url);
const fixture = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));
const agent = (mode = "act", log?: string) => ({ command: process.execPath, args: ["--import", require.resolve("tsx"), fixture, mode, ...(log ? [log] : [])] });
async function waitFor(predicate: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error("condition timed out"); await sleep(20); }
}

for (const mode of ["act", "propose"] as const) test(`fake ACP and real MCP ${mode} complete against room server and observer`, async (t) => {
  const ctx = await setup(); ctx.clock.t = Date.now(); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  if (mode === "propose") ctx.classifier.next = { addressedProbability: 0, worthCapturingProbability: 1, intent: "capture", intentProbability: 1, relatedShapeId: null, needsExternalDataProbability: 0, captureScore: 4 };
  const observer = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events")); await observer.ready; t.after(() => observer.close());
  const events: ExecutorEvent[] = [];
  const executor = await startRoomExecutor({ serverUrl: ctx.base, roomId: room.id, credential: { userId: u.id, secret: u.secret }, agent: agent(mode), autoClaim: true, onEvent: (event) => events.push(event) }); t.after(() => executor.close());
  await waitFor(() => events.some((e) => e.type === "connected"));
  await api(u, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: mode === "act" ? "@assistant add a concept" : "A concrete decision" }) });
  await waitFor(() => events.some((e) => e.type === "run.done"));
  const thread = ctx.server.engine.thread(room.id, 0, 100).entries;
  const turn = thread.find((e) => e.kind === "agent_turn");
  assert.equal(turn?.kind === "agent_turn" ? turn.text : undefined, mode === "propose" ? "Capture the desktop decision." : "Shared canvas updated.");
  assert.ok(observer.messages.some((m) => m.type === "event" && m.event.entry.kind === "agent_turn" && m.event.entry.status === "done"));
  if (mode === "act") assert.ok(ctx.server.engine.canvasSummary(room.id).shapes.some((s) => s.label === "From fake ACP"));
  else {
    assert.equal(ctx.server.engine.canvasSummary(room.id).shapes.length, 0);
    const suggestion = thread.find((e) => e.kind === "suggestion")!;
    const accepted = ctx.server.engine.resolveSuggestion(u.id, room.id, suggestion.id, "accepted");
    assert.ok(accepted.shapeId);
    const updatedTurn = ctx.server.engine.getEntry(room.id, turn!.id);
    assert.ok(updatedTurn?.kind === "agent_turn" && updatedTurn.touchedShapeIds.includes(accepted.shapeId!));
  }
});

test("completed trigger cannot be retried", async (t) => {
  const ctx = await setup({ classifier: null }); ctx.clock.t = Date.now(); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base), events: ExecutorEvent[] = [];
  const executor = await startRoomExecutor({ serverUrl: ctx.base, roomId: room.id, credential: { userId: u.id, secret: u.secret }, agent: agent(), autoClaim: true, onEvent: (event) => events.push(event) }); t.after(() => executor.close());
  await waitFor(() => events.some((e) => e.type === "connected"));
  await api(u, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant act" }) });
  await waitFor(() => events.filter((e) => e.type === "run.done").length === 1);
  await sleep(100);
  const trigger = ctx.server.engine.listTriggers(room.id)[0];
  assert.throws(() => ctx.server.engine.retryTrigger(u.id, room.id, trigger.id, randomUUID()));
  assert.equal(ctx.server.engine.listTriggers(room.id)[0].attempt, 1);
});

test("manual executor never runs until local claim intent", async (t) => {
  const ctx = await setup({ classifier: null }); ctx.clock.t = Date.now(); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base), events: ExecutorEvent[] = [];
  const executor = await startRoomExecutor({ serverUrl: ctx.base, roomId: room.id, credential: { userId: u.id, secret: u.secret }, agent: agent(), autoClaim: false, onEvent: (event) => events.push(event) }); t.after(() => executor.close());
  await waitFor(() => events.some((e) => e.type === "connected"));
  await api(u, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant act" }) }); await ctx.server.engine.classifierIdle(room.id);
  await sleep(150); assert.equal(events.filter((e) => e.type === "run.started").length, 0);
  await executor.claim(ctx.server.engine.listTriggers(room.id)[0].id);
  await waitFor(() => events.some((e) => e.type === "run.done"));
});

for (const mode of ["missing", "auth_required", "runtime-auth"] as const) test(`${mode} agent does not advertise ready after failure`, async (t) => {
  const ctx = await setup({ classifier: null }); ctx.clock.t = Date.now(); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base), events: ExecutorEvent[] = [];
  const executor = await startRoomExecutor({ serverUrl: ctx.base, roomId: room.id, credential: { userId: u.id, secret: u.secret }, agent: mode === "missing" ? { command: "/nonexistent-kan-agent", args: [] } : agent(mode), autoClaim: true, onEvent: (event) => events.push(event) }); t.after(() => executor.close());
  await waitFor(() => events.some((e) => e.type === "connected"));
  if (mode === "runtime-auth") {
    await api(u, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant act" }) });
    await waitFor(() => events.some((e) => e.type === "run.failed")); await sleep(100);
  }
  assert.equal(events.filter((e) => e.type === "ready").at(-1)?.ready, false);
});

test("close during delayed successful claim waits and never starts a run", async (t) => {
  const ctx = await setup({ classifier: null }); ctx.clock.t = Date.now(); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base), events: ExecutorEvent[] = [];
  const dir = mkdtempSync(join(tmpdir(), "kan-runner-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "starts");
  const executor = await startRoomExecutor({ serverUrl: ctx.base, roomId: room.id, credential: { userId: u.id, secret: u.secret }, agent: agent("act", log), autoClaim: false, onEvent: (event) => events.push(event) }); t.after(() => executor.close());
  await waitFor(() => events.some((e) => e.type === "connected"));
  await api(u, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant act" }) }); await ctx.server.engine.classifierIdle(room.id);
  const original = globalThis.fetch; let claimed = false; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = async (input, init) => { const response = await original(input, init); if (String(input).endsWith("/claim")) { claimed = true; await gate; } return response; };
  t.after(() => { globalThis.fetch = original; release(); });
  const claiming = executor.claim(ctx.server.engine.listTriggers(room.id)[0].id).catch(() => {});
  await waitFor(() => claimed);
  let closed = false; const closing = executor.close().then(() => { closed = true; });
  await sleep(50); assert.equal(closed, false);
  release(); await claiming; await closing; await sleep(100);
  assert.equal(events.filter((e) => e.type === "run.started").length, 0);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
});

test("autoClaim must be an explicit boolean before any local process starts", async () => {
  await assert.rejects(startRoomExecutor({ serverUrl: "http://localhost:8787", roomId: randomUUID(), credential: { userId: randomUUID(), secret: "0".repeat(64) }, agent: agent(), autoClaim: "false" as unknown as boolean }), /invalid_auto_claim/);
});

test("permissions use structured exact names, never titles; safe env and URL validation", () => {
  const request = { sessionId: "x", toolCall: { toolCallId: "x", title: "mcp__kan-canvas__addNode" }, options: [{ optionId: "a", name: "Allow", kind: "allow_once" as const }] };
  assert.equal(permissionResult(request, new Set(["mcp__kan-canvas__addNode"])).outcome.outcome, "cancelled");
  assert.equal(permissionResult({ ...request, toolCall: { ...request.toolCall, name: "mcp__kan-canvas__addNode" } }, new Set(["mcp__kan-canvas__addNode"])).outcome.outcome, "selected");
  assert.deepEqual(safeEnvironment({ PATH: "p", HOME: "h", KAN_USER_SECRET: "secret", AI_GATEWAY_API_KEY: "secret" }), { PATH: "p", HOME: "h" });
  for (const url of ["http://remote.example", "https://u:p@example.com", "file:///tmp/x"]) assert.throws(() => validateServerUrl(url));
});
