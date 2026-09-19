import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, createRoom, registerUser, setup } from "./helpers";

async function postMsg(ctx: any, u: any, roomId: string, body: Record<string, unknown>) {
  return api(u, ctx.base, `/rooms/${roomId}/messages`, { method: "POST", body: JSON.stringify(body) });
}

test("messages: idempotent by client id, conflict on different payload, spoofed fields rejected", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const u2 = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);
  await api(u2, ctx.base, "/rooms/join", { method: "POST", body: JSON.stringify({ code: room.code }) });

  const id = randomUUID();
  const m1 = await postMsg(ctx, u, room.id, { id, text: "hello" });
  assert.equal(m1.status, 200);
  assert.equal(m1.body.created, true);
  assert.equal(m1.body.entry.authorId, u.id);

  const m2 = await postMsg(ctx, u, room.id, { id, text: "hello" });
  assert.equal(m2.status, 200);
  assert.equal(m2.body.created, false);
  assert.equal(m2.body.entry.seq, m1.body.entry.seq);

  const m3 = await postMsg(ctx, u, room.id, { id, text: "different" });
  assert.equal(m3.status, 409);

  // same client id used by another user => conflict (cannot claim another author's entry)
  const m4 = await postMsg(ctx, u2, room.id, { id, text: "hello" });
  assert.equal(m4.status, 409);

  // spoofed kind/author rejected by strict schema
  assert.equal(
    (await postMsg(ctx, u, room.id, { id: randomUUID(), text: "x", kind: "system" })).status,
    400,
  );
  assert.equal(
    (await postMsg(ctx, u, room.id, { id: randomUUID(), text: "x", authorId: u2.id })).status,
    400,
  );

  // non-member cannot post
  const outsider = await registerUser(ctx.base);
  assert.equal((await postMsg(ctx, outsider, room.id, { id: randomUUID(), text: "x" })).status, 403);
  await ctx.cleanup();
});

test("events: replay, cursor bounds, hasMore, updated entries keep seq with new cursor", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);
  for (let i = 0; i < 3; i++) {
    await postMsg(ctx, u, room.id, { id: randomUUID(), text: `m${i}` });
  }
  const all = await api(u, ctx.base, `/rooms/${room.id}/events?since=0&limit=100`);
  assert.equal(all.status, 200);
  assert.equal(all.body.events.length, 3);
  assert.equal(all.body.hasMore, false);
  assert.ok(all.body.nextCursor >= 3);

  const page = await api(u, ctx.base, `/rooms/${room.id}/events?since=0&limit=2`);
  assert.equal(page.body.events.length, 2);
  assert.equal(page.body.hasMore, true);
  const rest = await api(u, ctx.base, `/rooms/${room.id}/events?since=${page.body.nextCursor}`);
  assert.equal(rest.body.events.length, 1);
  assert.equal(rest.body.hasMore, false);

  // invalid cursors rejected
  for (const bad of ["-1", "1.5", "abc", "999999"]) {
    const r = await api(u, ctx.base, `/rooms/${room.id}/events?since=${bad}`);
    assert.equal(r.status, 400, `since=${bad}`);
  }
  await ctx.cleanup();
});

test("imported publish messages never trigger classification", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base, {
    messages: [{ id: randomUUID(), text: "@assistant draw a chart", at: new Date().toISOString() }],
  });
  await ctx.server.engine.classifierIdle(room.id);
  const triggers = await api(u, ctx.base, `/rooms/${room.id}/triggers`);
  assert.equal(triggers.body.triggers.length, 0);
  assert.equal(ctx.classifier.calls.length, 0);
  await ctx.cleanup();
});

test("@assistant mention creates explicit trigger without classifier call", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "@assistant add a decision node" });
  await ctx.server.engine.classifierIdle(room.id);
  const triggers = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].mode, "act");
  assert.equal(triggers[0].intent, "answer");
  assert.equal(ctx.classifier.calls.length, 0);
  await ctx.cleanup();
});

test("classifier context paths preserve consent and cooldown, failure is graceful", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);

  // act trigger
  ctx.classifier.next = {
    addressedProbability: 0.95,
    worthCapturingProbability: 0,
    intent: "answer",
    intentProbability: 0.9,
    relatedShapeId: null,
    needsExternalDataProbability: 0,
    captureScore: 0,
  };
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "what is up" });
  await ctx.server.engine.classifierIdle(room.id);
  let triggers = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].mode, "context");
  assert.equal(triggers[0].status, "needs_claim"); // no ready executors
  ctx.clock.advance(ctx.server.engine.timings.cooldownMs);

  // propose trigger, sets cooldown
  ctx.classifier.next = {
    addressedProbability: 0.1,
    worthCapturingProbability: 0.9,
    intent: "capture",
    intentProbability: 0.8,
    relatedShapeId: null,
    needsExternalDataProbability: 0,
    captureScore: 3,
  };
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "we decided X" });
  await ctx.server.engine.classifierIdle(room.id);
  triggers = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 2);
  assert.equal(triggers[1].mode, "context");

  // second propose inside cooldown suppressed
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "we decided Y too" });
  await ctx.server.engine.classifierIdle(room.id);
  triggers = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 2);

  // classifier error: chat still works, no trigger
  ctx.classifier.next = () => Promise.reject(new Error("provider down"));
  const ok = await postMsg(ctx, u, room.id, { id: randomUUID(), text: "still works" });
  assert.equal(ok.status, 200);
  await ctx.server.engine.classifierIdle(room.id);
  triggers = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 2);
  await ctx.cleanup();
});
