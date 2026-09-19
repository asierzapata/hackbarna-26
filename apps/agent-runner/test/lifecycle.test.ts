import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setup, registerUser, createRoom, api, sleep } from "../../room-server/test/helpers";
import { startRoomExecutor, type ExecutorEvent } from "../src/executor";
import { forbidden } from "../../room-server/src/errors";
import { requestJson } from "../src/run-client";

const require = createRequire(import.meta.url);
const command = (mode: string) => ({ command: process.execPath, args: ["--import", require.resolve("tsx"), fileURLToPath(new URL("./fake-agent.ts", import.meta.url)), mode] });
async function wait(predicate: () => boolean, timeout = 6000) { const deadline = Date.now() + timeout; while (!predicate()) { if (Date.now() > deadline) throw new Error("timeout"); await sleep(20); } }

test("events disconnect during claim never starts stale lease, reconnect uses fresh ticket", async (t) => {
  const ctx = await setup({ classifier: null }); ctx.clock.t = Date.now(); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base), events: ExecutorEvent[] = [];
  const executor = await startRoomExecutor({ serverUrl: ctx.base, roomId: room.id, credential: { userId: user.id, secret: user.secret }, agent: command("act"), autoClaim: false, onEvent: (e) => events.push(e) }); t.after(() => executor.close());
  await wait(() => events.some((e) => e.type === "connected"));
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant act" }) }); await ctx.server.engine.classifierIdle(room.id);
  const original = globalThis.fetch; let claimed = false; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = async (input, init) => { const res = await original(input, init); if (String(input).endsWith("/claim")) { claimed = true; await gate; } return res; };
  t.after(() => { globalThis.fetch = original; release(); });
  const task = executor.claim(ctx.server.engine.listTriggers(room.id)[0].id).catch(() => {}); await wait(() => claimed);
  for (const session of ctx.server.engine.getRoomHandle(room.id).sessions.values()) session.ws?.terminate();
  await wait(() => events.some((e) => e.type === "disconnected")); release(); await task;
  await wait(() => events.filter((e) => e.type === "connected").length >= 2);
  assert.equal(events.filter((e) => e.type === "run.started").length, 0);
  assert.equal(ctx.server.engine.listTriggers(room.id)[0].status, "failed");
  assert.ok(Number(ctx.server.engine.db.prepare("SELECT COUNT(*) n FROM tickets WHERE used=1").get()!.n) >= 2);
});

test("close during manual preflight waits for child cleanup and does not advertise readiness", async (t) => {
  const ctx = await setup({ classifier: null }); ctx.clock.t = Date.now(); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base), events: ExecutorEvent[] = [];
  const executor = await startRoomExecutor({ serverUrl: ctx.base, roomId: room.id, credential: { userId: user.id, secret: user.secret }, agent: command("slow-preflight"), autoClaim: false, onEvent: (e) => events.push(e) }); t.after(() => executor.close());
  await wait(() => events.some((e) => e.type === "connected"));
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant act" }) }); await ctx.server.engine.classifierIdle(room.id);
  const task = executor.claim(ctx.server.engine.listTriggers(room.id)[0].id).catch(() => {}); await sleep(50);
  await executor.close(); await task;
  assert.equal(events.some((e) => e.type === "run.started" || (e.type === "ready" && e.ready)), false);
});

test("disconnect cancels active agent and fresh reconnect never reruns old lease", async (t) => {
  const ctx = await setup({ classifier: null }); ctx.clock.t = Date.now(); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base), events: ExecutorEvent[] = [];
  const executor = await startRoomExecutor({ serverUrl: ctx.base, roomId: room.id, credential: { userId: user.id, secret: user.secret }, agent: command("wait"), autoClaim: true, onEvent: (e) => events.push(e) }); t.after(() => executor.close());
  await wait(() => events.some((e) => e.type === "connected"));
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant act" }) });
  await wait(() => ctx.server.engine.thread(room.id, 0, 100).entries.some((e) => e.kind === "agent_turn" && e.text === "waiting"));
  for (const session of ctx.server.engine.getRoomHandle(room.id).sessions.values()) session.ws?.terminate();
  await wait(() => events.some((e) => e.type === "run.failed"));
  await wait(() => events.filter((e) => e.type === "connected").length >= 2); await sleep(200);
  assert.equal(events.filter((e) => e.type === "run.started").length, 1);
  assert.equal(ctx.server.engine.listTriggers(room.id)[0].status, "failed");
  assert.equal(ctx.server.engine.canvasSummary(room.id).shapes.length, 0);
});

test("heartbeat rejection cancels process and permits no late writes", { timeout: 18000 }, async (t) => {
  const ctx = await setup({ classifier: null }); ctx.clock.t = Date.now(); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base), events: ExecutorEvent[] = [];
  const executor = await startRoomExecutor({ serverUrl: ctx.base, roomId: room.id, credential: { userId: user.id, secret: user.secret }, agent: command("wait"), autoClaim: true, onEvent: (e) => events.push(e) }); t.after(() => executor.close());
  await wait(() => events.some((e) => e.type === "connected"));
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant act" }) });
  await wait(() => ctx.server.engine.thread(room.id, 0, 100).entries.some((e) => e.kind === "agent_turn" && e.text === "waiting"));
  ctx.server.engine.heartbeatRun = () => { throw forbidden("fixture rejection"); };
  const count = Number(ctx.server.engine.db.prepare("SELECT COUNT(*) n FROM events").get()!.n);
  await wait(() => events.some((e) => e.type === "run.failed"), 12000); await sleep(200);
  assert.equal(Number(ctx.server.engine.db.prepare("SELECT COUNT(*) n FROM events").get()!.n), count);
  assert.equal(ctx.server.engine.canvasSummary(room.id).shapes.length, 0);
});

test("stream snapshots are coalesced and cap text and steps without thoughts or raw tool output", async (t) => {
  const ctx = await setup({ classifier: null }); ctx.clock.t = Date.now(); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base), events: ExecutorEvent[] = [];
  const original = globalThis.fetch; const writes: { at: number; body: { status?: string; text: string; steps: unknown[] } }[] = [];
  globalThis.fetch = async (input, init) => { if (init?.method === "PATCH") writes.push({ at: Date.now(), body: JSON.parse(String(init.body)) }); return original(input, init); };
  t.after(() => { globalThis.fetch = original; });
  const executor = await startRoomExecutor({ serverUrl: ctx.base, roomId: room.id, credential: { userId: user.id, secret: user.secret }, agent: command("stream"), autoClaim: true, onEvent: (e) => events.push(e) }); t.after(() => executor.close());
  await wait(() => events.some((e) => e.type === "connected"));
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant act" }) });
  await wait(() => events.some((e) => e.type === "run.done"));
  const snapshots = writes.filter((write) => !write.body.status);
  assert.ok(snapshots.length >= 1 && snapshots.length <= 4);
  for (let i = 1; i < snapshots.length; i++) assert.ok(snapshots[i].at - snapshots[i - 1].at >= 200);
  const terminal = writes.filter((write) => write.body.status); assert.equal(terminal.length, 1);
  assert.equal(terminal[0].body.text.length, 50000); assert.equal(terminal[0].body.steps.length, 200);
  assert.deepEqual(terminal[0].body.steps[0], { id: "0", tool: "unknown", status: "failed" });
  assert.equal(new Set(terminal[0].body.steps.map((step) => (step as { id: string }).id)).size, 200);
  assert.ok(!JSON.stringify(writes).includes("not streamed") && !JSON.stringify(writes).includes("private thought"));
});

test("tool metadata upserts stable bounded ids and recognizes only structured exposed tool names", async (t) => {
  const ctx = await setup({ classifier: null }); ctx.clock.t = Date.now(); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base), events: ExecutorEvent[] = [];
  const original = globalThis.fetch;
  const writes: { status?: string; steps: { id: string; tool: string; status: string }[] }[] = [];
  globalThis.fetch = async (input, init) => { if (init?.method === "PATCH") writes.push(JSON.parse(String(init.body))); return original(input, init); };
  t.after(() => { globalThis.fetch = original; });
  const executor = await startRoomExecutor({ serverUrl: ctx.base, roomId: room.id, credential: { userId: user.id, secret: user.secret }, agent: command("metadata"), autoClaim: true, onEvent: (e) => events.push(e) }); t.after(() => executor.close());
  await wait(() => events.some((e) => e.type === "connected"));
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant act" }) });
  await wait(() => events.some((e) => e.type === "run.done"));
  const terminal = writes.find((write) => write.status === "done")!;
  const entry = ctx.server.engine.thread(room.id, 0, 100).entries.find((entry) => entry.kind === "agent_turn");
  assert.ok(entry?.kind === "agent_turn");
  assert.equal(entry.status, "done");
  assert.deepEqual(entry.steps, terminal.steps);
  assert.equal(terminal.steps.length, 3);
  assert.deepEqual(terminal.steps[0], { id: "call-known", tool: "addNode", status: "completed" });
  assert.deepEqual(terminal.steps[1], { id: "call-unknown", tool: "unknown", status: "completed" });
  assert.match(terminal.steps[2].id, /^call_[0-9a-f]{64}$/);
  assert.equal(terminal.steps[2].tool, "getCanvas"); assert.equal(terminal.steps[2].status, "completed");
  for (const status of ["pending", "in_progress", "completed"]) assert.ok(writes.some((write) => write.steps.some((step) => step.id === "call-known" && step.tool === "addNode" && step.status === status)), status);
  for (const write of writes) assert.equal(new Set(write.steps.map((step) => step.id)).size, write.steps.length);
  for (const forbidden of ["not streamed", "private thought", "sensitive-title", "sensitive-id", "mcp__kan-canvas__queryData"]) assert.ok(!JSON.stringify(writes).includes(forbidden));
});

test("configured session deadline terminates agent and writes one failed terminal status", async (t) => {
  const ctx = await setup({ classifier: null }); ctx.clock.t = Date.now(); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base), events: ExecutorEvent[] = [];
  const executor = await startRoomExecutor({ serverUrl: ctx.base, roomId: room.id, credential: { userId: user.id, secret: user.secret }, agent: command("wait"), autoClaim: true, sessionTimeoutMs: 1000, onEvent: (e) => events.push(e) }); t.after(() => executor.close());
  await wait(() => events.some((e) => e.type === "connected"));
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant act" }) });
  await wait(() => events.some((e) => e.type === "run.failed"));
  assert.equal(ctx.server.engine.listTriggers(room.id)[0].status, "failed");
  assert.equal(events.filter((e) => e.type === "run.failed").length, 1);
  assert.equal(ctx.server.engine.canvasSummary(room.id).shapes.length, 0);
});

test("safe retries retain request UUID and stop after one retry", async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const bodies: unknown[] = [];
  globalThis.fetch = async (_input, init) => { bodies.push(init?.body); return new Response("{}", { status: 503 }); };
  const body = { id: randomUUID(), text: "snapshot" };
  await assert.rejects(requestJson("https://example.invalid", "lease", "PATCH", body, true));
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  bodies.length = 0;
  await assert.rejects(requestJson("https://example.invalid", "lease", "POST", body, false)); assert.equal(bodies.length, 1);
});
