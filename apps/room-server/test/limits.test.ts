import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import WebSocket from "ws";
import { setup, registerUser, createRoom, api, ticket, EventsClient } from "./helpers";

async function readyRun(ctx: Awaited<ReturnType<typeof setup>>, text = "@assistant act") {
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(user, ctx.base, room.id, "events")); await ev.ready;
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text }) }); await ctx.server.engine.classifierIdle(room.id);
  ctx.server.engine.setExecutorReady(room.id, ev.sessionId, true, "fixture");
  const trigger = ctx.server.engine.listTriggers(room.id)[0];
  const lease = ctx.server.engine.claimTrigger(user.id, room.id, trigger.id, { sessionId: ev.sessionId, manual: true });
  return { user, room, ev, trigger, lease, auth: `Bearer ${lease.leaseToken}` };
}

test("run touched limit 500 rejects excess atomically and generated ids include run identity", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const { user, room, ev, trigger, lease, auth } = await readyRun(ctx);
  const requestId = randomUUID();
  const first = ctx.server.engine.mutate(room.id, lease.runId, auth, { id: requestId, operations: [{ type: "add", draft: { type: "concept", label: "first" } }] });
  for (let start = 1; start < 500; start += 100) {
    const response = await api(null, ctx.base, `/rooms/${room.id}/runs/${lease.runId}/mutate`, { method: "POST", headers: { authorization: auth }, body: JSON.stringify({ id: randomUUID(), operations: Array.from({ length: Math.min(100, 500 - start) }, () => ({ type: "add", draft: { type: "concept", label: "node" } })) }) });
    assert.equal(response.status, 200);
  }
  const rejected = await api(null, ctx.base, `/rooms/${room.id}/runs/${lease.runId}/mutate`, { method: "POST", headers: { authorization: auth }, body: JSON.stringify({ id: randomUUID(), operations: [{ type: "add", draft: { type: "concept", label: "overflow" } }] }) });
  assert.equal(rejected.status, 400); assert.equal(ctx.server.engine.canvasSummary(room.id).counts.shapes, 500);
  ctx.server.engine.patchRun(room.id, lease.runId, auth, { id: randomUUID(), status: "failed" });
  ctx.server.engine.retryTrigger(user.id, room.id, trigger.id, randomUUID());
  const secondLease = ctx.server.engine.claimTrigger(user.id, room.id, trigger.id, { sessionId: ev.sessionId, manual: true });
  const second = ctx.server.engine.mutate(room.id, secondLease.runId, `Bearer ${secondLease.leaseToken}`, { id: requestId, operations: [{ type: "add", draft: { type: "concept", label: "second" } }] });
  assert.notEqual(first.shapeIds[0], second.shapeIds[0]);
  const selection = ctx.server.engine.runCanvas(room.id, secondLease.runId, `Bearer ${secondLease.leaseToken}`, { scope: "selection", shapeIds: second.shapeIds });
  assert.ok("records" in selection && selection.records.length === 1 && (selection.records[0] as any).props.draft.label === "second");
});

test("future websocket cursor does not consume ticket, exact expiry rejects unused ticket", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  const token = await ticket(user, ctx.base, room.id, "events");
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.server.port()}/events/${room.id}?ticket=${token}&since=1`);
    ws.on("error", () => resolve());
  });
  const valid = new EventsClient(ctx.server.port(), room.id, token); await valid.ready; valid.close();
  const expiring = ctx.server.engine.createTicket(user.id, room.id, "events"); ctx.clock.t = expiring.expiresAt;
  assert.throws(() => ctx.server.engine.consumeTicket(room.id, "events", expiring.ticket));
  assert.equal(ctx.server.engine.db.prepare("SELECT used FROM tickets WHERE hash=?").get(createHash("sha256").update(expiring.ticket).digest("hex"))!.used, 0);
});

test("legacy suggestion deterministic shape collision returns conflict without overwriting human work", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  const entry = { id: randomUUID(), roomId: room.id, seq: 1, at: new Date().toISOString(), kind: "suggestion", triggerId: randomUUID(), runId: randomUUID(), draft: { type: "concept", label: "Suggestion" }, status: "open", shapeId: null };
  ctx.server.engine.db.prepare("INSERT INTO entries(room_id,seq,id,kind,data,at) VALUES (?,?,?,?,?,?)").run(room.id, entry.seq, entry.id, entry.kind, JSON.stringify(entry), entry.at);
  const id = `shape:k${createHash("sha256").update(`suggest:${entry.id}:0`).digest("hex").slice(0, 24)}`;
  const human = { id, typeName: "shape", type: "kan-node", x: 0, y: 0, rotation: 0, parentId: "page:page", index: "a1", isLocked: false, opacity: 1, meta: {}, props: { w: 320, h: 200, draft: { type: "concept", label: "Human preserved" } } };
  ctx.server.engine.getRoomHandle(room.id).storage.transaction((txn) => txn.set(id, human as never));
  assert.throws(() => ctx.server.engine.resolveSuggestion(user.id, room.id, entry.id, "accepted"), (error: { status?: number }) => error.status === 409);
  assert.deepEqual(ctx.server.engine.canvasRecords(room.id).find((r: any) => r.id === id), human);
  const suggestion = ctx.server.engine.getEntry(room.id, entry.id); assert.ok(suggestion?.kind === "suggestion" && suggestion.status === "open");
});

test("video token generation failures are sanitized and in-flight session prevents eviction", async (t) => {
  let resolve!: (value: { sessionId: string }) => void;
  const ctx = await setup({ classifier: null, video: { applicationId: "application", createSession: () => new Promise((r) => { resolve = r; }), generateClientToken: () => { throw new Error("private provider credential"); } } }); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base), handle = ctx.server.engine.getRoomHandle(room.id);
  const pending = ctx.server.engine.videoToken(user.id, room.id);
  ctx.clock.advance(120000); ctx.server.engine.tick(); assert.equal(ctx.server.engine.getRoomHandle(room.id), handle);
  resolve({ sessionId: "session" }); await assert.rejects(pending, (error: Error) => !error.message.includes("credential") && error.message === "video provider failed");
  assert.equal(handle.videoSessionPromise, null);
});
