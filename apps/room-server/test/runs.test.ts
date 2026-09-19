import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, createRoom, registerUser, setup, sleep, ticket, EventsClient } from "./helpers";

async function explicitTrigger(ctx: any, u: any, roomId: string) {
  await api(u, ctx.base, `/rooms/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({ id: randomUUID(), text: "@assistant do the thing" }),
  });
  await ctx.server.engine.classifierIdle(roomId);
  const triggers = (await api(u, ctx.base, `/rooms/${roomId}/triggers`)).body.triggers;
  return triggers.at(-1);
}

test("no ready executors -> needs_claim; ready client arriving gets autooffered", async () => {
  const ctx = await setup({ classifier: null });
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);
  const trig = await explicitTrigger(ctx, u, room.id);
  ctx.server.engine.tick();
  let triggers = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers[0].status, "needs_claim");

  // observer without ready can't claim
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events"));
  await ev.ready;
  const denied = await api(u, ctx.base, `/rooms/${room.id}/triggers/${trig.id}/claim`, {
    method: "POST",
    body: JSON.stringify({ sessionId: ev.sessionId, manual: true }),
  });
  assert.equal(denied.status, 409);

  // when it readies, scheduler autooffers
  ev.executorReady("agent-a");
  ctx.server.engine.tick();
  triggers = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers[0].status, "offered");
  assert.equal(triggers[0].assigneeSessionId, ev.sessionId);
  ev.close();
  await ctx.cleanup();
});

test("claim -> lease -> heartbeat -> mutate -> done; stale lease denied; idempotent mutate", async () => {
  const ctx = await setup({ classifier: null });
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);
  const trig = await explicitTrigger(ctx, u, room.id);

  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events"));
  await ev.ready;
  ev.executorReady("agent-x");
  ctx.server.engine.tick();

  const claim = await api(u, ctx.base, `/rooms/${room.id}/triggers/${trig.id}/claim`, {
    method: "POST",
    body: JSON.stringify({ sessionId: ev.sessionId }),
  });
  assert.equal(claim.status, 200);
  const lease = claim.body.lease;
  assert.ok(lease.leaseToken.length >= 64);
  const runAuth = { authorization: `Bearer ${lease.leaseToken}` };

  // context
  const context = await api(null, ctx.base, `/rooms/${room.id}/runs/${lease.runId}/context`, { headers: runAuth });
  assert.equal(context.status, 200);
  assert.equal(context.body.trigger.id, trig.id);
  assert.ok(context.body.causeEntries.length >= 1);
  assert.ok(context.body.canvas.counts.records >= 1);

  // heartbeat renews
  ctx.clock.advance(10_000);
  const hb = await api(null, ctx.base, `/rooms/${room.id}/runs/${lease.runId}/heartbeat`, {
    method: "POST",
    headers: runAuth,
  });
  assert.equal(hb.status, 200);
  assert.ok(hb.body.expiresAt > ctx.clock.t);

  // mutate add
  const mutateId = randomUUID();
  const mut = await api(null, ctx.base, `/rooms/${room.id}/runs/${lease.runId}/mutate`, {
    method: "POST",
    headers: runAuth,
    body: JSON.stringify({
      id: mutateId,
      operations: [{ type: "add", draft: { type: "markdown", title: "Note", body: "hi" }, x: 10, y: 20 }],
    }),
  });
  assert.equal(mut.status, 200, JSON.stringify(mut.body));
  const shapeId = mut.body.shapeIds[0];
  assert.match(shapeId, /^shape:/);

  // idempotent retry returns same ids
  const mut2 = await api(null, ctx.base, `/rooms/${room.id}/runs/${lease.runId}/mutate`, {
    method: "POST",
    headers: runAuth,
    body: JSON.stringify({
      id: mutateId,
      operations: [{ type: "add", draft: { type: "markdown", title: "Note", body: "hi" }, x: 10, y: 20 }],
    }),
  });
  assert.deepEqual(mut2.body.shapeIds, mut.body.shapeIds);
  const canvas = await api(u, ctx.base, `/rooms/${room.id}/canvas`);
  assert.equal(canvas.body.records.filter((r: any) => r.id === shapeId).length, 1);

  // provenance stamped by server
  const rec = canvas.body.records.find((r: any) => r.id === shapeId);
  assert.equal(rec.meta.provenance.runId, lease.runId);
  assert.equal(rec.meta.provenance.byUserId, u.id);

  // invalid batch is atomic: second op references a missing shape -> zero writes
  const before = (await api(u, ctx.base, `/rooms/${room.id}/canvas`)).body.records.length;
  const badBatch = await api(null, ctx.base, `/rooms/${room.id}/runs/${lease.runId}/mutate`, {
    method: "POST",
    headers: runAuth,
    body: JSON.stringify({
      id: randomUUID(),
      operations: [
        { type: "add", draft: { type: "concept", label: "x" } },
        { type: "update", shapeId: "shape:does-not-exist", draft: { type: "concept", label: "y" } },
      ],
    }),
  });
  assert.equal(badBatch.status, 400);
  const after = (await api(u, ctx.base, `/rooms/${room.id}/canvas`)).body.records.length;
  assert.equal(before, after);

  // agent entry has touchedShapeIds
  const thread = await api(u, ctx.base, `/rooms/${room.id}/thread`);
  const agentEntry = thread.body.entries.find((e: any) => e.kind === "agent_turn");
  assert.ok(agentEntry.touchedShapeIds.includes(shapeId));

  // patch done; terminal retry with same id returns stored response
  const patchId = randomUUID();
  const done = await api(null, ctx.base, `/rooms/${room.id}/runs/${lease.runId}`, {
    method: "PATCH",
    headers: runAuth,
    body: JSON.stringify({ id: patchId, text: "done!", status: "done" }),
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.entry.status, "done");
  const doneRetry = await api(null, ctx.base, `/rooms/${room.id}/runs/${lease.runId}`, {
    method: "PATCH",
    headers: runAuth,
    body: JSON.stringify({ id: patchId, text: "tampered", status: "failed" }),
  });
  assert.equal(doneRetry.status, 200);
  assert.equal(doneRetry.body.entry.text, "done!");
  // new request id on finished run is rejected
  const late = await api(null, ctx.base, `/rooms/${room.id}/runs/${lease.runId}`, {
    method: "PATCH",
    headers: runAuth,
    body: JSON.stringify({ id: randomUUID(), text: "no", status: "done" }),
  });
  assert.equal(late.status, 403);
  ev.close();
  await ctx.cleanup();
});

test("simultaneous claims: only one wins; offer expiry reassigns; disconnect releases offer", async () => {
  const ctx = await setup({ classifier: null });
  const u1 = await registerUser(ctx.base, "one");
  const u2 = await registerUser(ctx.base, "two");
  const room = await createRoom(u1, ctx.base);
  await api(u2, ctx.base, "/rooms/join", { method: "POST", body: JSON.stringify({ code: room.code }) });
  const trig = await explicitTrigger(ctx, u1, room.id);

  const ev1 = new EventsClient(ctx.server.port(), room.id, await ticket(u1, ctx.base, room.id, "events"));
  const ev2 = new EventsClient(ctx.server.port(), room.id, await ticket(u2, ctx.base, room.id, "events"));
  await Promise.all([ev1.ready, ev2.ready]);
  ev1.executorReady("a1");
  ev2.executorReady("a2");
  ctx.server.engine.tick();

  // requester u1's session should be offered first
  let t = (await api(u1, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers[0];
  assert.equal(t.status, "offered");
  assert.equal(t.assigneeSessionId, ev1.sessionId);

  // u2 cannot steal a live offer
  const steal = await api(u2, ctx.base, `/rooms/${room.id}/triggers/${trig.id}/claim`, {
    method: "POST",
    body: JSON.stringify({ sessionId: ev2.sessionId }),
  });
  assert.equal(steal.status, 409);

  // offer expiry -> reassign to u2 (u1 already offered this cycle)
  ctx.clock.advance(6000);
  ctx.server.engine.tick();
  t = (await api(u1, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers[0];
  assert.equal(t.status, "offered");
  assert.equal(t.assigneeSessionId, ev2.sessionId);

  // disconnect u2 -> offer released, back to needs_claim (u1 already tried, u2 gone)
  ev2.close();
  await sleep(50);
  ctx.server.engine.tick();
  t = (await api(u1, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers[0];
  assert.equal(t.status, "needs_claim");

  // manual claim by u1's still-live session
  const claim = await api(u1, ctx.base, `/rooms/${room.id}/triggers/${trig.id}/claim`, {
    method: "POST",
    body: JSON.stringify({ sessionId: ev1.sessionId, manual: true }),
  });
  assert.equal(claim.status, 200);
  ev1.close();
  await ctx.cleanup();
});

test("lease expiry marks run failed, stale mutations denied, no auto-replay, explicit retry", async () => {
  const ctx = await setup({ classifier: null });
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);
  const trig = await explicitTrigger(ctx, u, room.id);
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events"));
  await ev.ready;
  ev.executorReady();
  ctx.server.engine.tick();
  const claim = await api(u, ctx.base, `/rooms/${room.id}/triggers/${trig.id}/claim`, {
    method: "POST",
    body: JSON.stringify({ sessionId: ev.sessionId }),
  });
  const lease = claim.body.lease;
  const runAuth = { authorization: `Bearer ${lease.leaseToken}` };

  ctx.clock.advance(31_000);
  ctx.server.engine.tick();
  let t = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers[0];
  assert.equal(t.status, "expired");

  // stale mutation denied
  const stale = await api(null, ctx.base, `/rooms/${room.id}/runs/${lease.runId}/mutate`, {
    method: "POST",
    headers: runAuth,
    body: JSON.stringify({ id: randomUUID(), operations: [{ type: "add", draft: { type: "concept", label: "z" } }] }),
  });
  assert.equal(stale.status, 403);

  // explicit retry -> new pending attempt, old agent entry kept
  const retry = await api(u, ctx.base, `/rooms/${room.id}/triggers/${trig.id}/retry`, {
    method: "POST",
    body: JSON.stringify({ id: randomUUID() }),
  });
  assert.equal(retry.status, 200);
  t = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers[0];
  assert.equal(t.status, "pending");
  const thread = await api(u, ctx.base, `/rooms/${room.id}/thread`);
  assert.ok(thread.body.entries.some((e: any) => e.kind === "agent_turn" && e.status === "failed"));
  ev.close();
  await ctx.cleanup();
});

test("context mode: mutation denied, structured draft approval is atomic and opposite resolution conflicts", async () => {
  const ctx = await setup();
  const u1 = await registerUser(ctx.base, "p1");
  const u2 = await registerUser(ctx.base, "p2");
  const room = await createRoom(u1, ctx.base);
  await api(u2, ctx.base, "/rooms/join", { method: "POST", body: JSON.stringify({ code: room.code }) });
  ctx.classifier.next = { addressedProbability: 0.1, worthCapturingProbability: 0.95, intent: "capture", intentProbability: 0.8, relatedShapeId: null, needsExternalDataProbability: 0, captureScore: 3 };
  await api(u1, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "decision: use sqlite" }) });
  await ctx.server.engine.classifierIdle(room.id);
  const trig = (await api(u1, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers[0];
  assert.equal(trig.mode, "context");
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u1, ctx.base, room.id, "events")); await ev.ready; ev.executorReady(); ctx.server.engine.tick();
  const claim = await api(u1, ctx.base, `/rooms/${room.id}/triggers/${trig.id}/claim`, { method: "POST", body: JSON.stringify({ sessionId: ev.sessionId }) });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const auth = { authorization: `Bearer ${claim.body.lease.leaseToken}` };
  const denied = await api(null, ctx.base, `/rooms/${room.id}/runs/${claim.body.lease.runId}/mutate`, { method: "POST", headers: auth, body: JSON.stringify({ id: randomUUID(), operations: [{ type: "add", draft: { type: "concept", label: "no" } }] }) });
  assert.equal(denied.status, 403);
  const context = await api(null, ctx.base, `/rooms/${room.id}/runs/${claim.body.lease.runId}/context`, { headers: auth });
  const completed = await api(null, ctx.base, `/rooms/${room.id}/runs/${claim.body.lease.runId}/complete`, { method: "POST", headers: auth, body: JSON.stringify({ id: randomUUID(), revision: context.body.revision, result: { kind: "draft", text: "Capture the decision", sources: [{ kind: "entry", id: trig.causeEntryIds[0] }], draft: { type: "decision", title: "Use sqlite", bullets: ["a", "b"] } } }) });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const suggestion = completed.body.outcomeEntry;
  const first = await api(u1, ctx.base, `/rooms/${room.id}/suggestions/${suggestion.id}/resolve`, { method: "POST", body: JSON.stringify({ resolution: "accepted" }) });
  const second = await api(u2, ctx.base, `/rooms/${room.id}/suggestions/${suggestion.id}/resolve`, { method: "POST", body: JSON.stringify({ resolution: "accepted" }) });
  assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(first.body.shapeId, second.body.shapeId);
  const canvas = await api(u1, ctx.base, `/rooms/${room.id}/canvas`); assert.equal(canvas.body.records.filter((r: any) => r.type === "kan-node").length, 1);
  const opposite = await api(u2, ctx.base, `/rooms/${room.id}/suggestions/${suggestion.id}/resolve`, { method: "POST", body: JSON.stringify({ resolution: "dismissed" }) }); assert.equal(opposite.status, 409);
  ev.close(); await ctx.cleanup();
});

test("data/query requires a live lease and calls demo data verbatim", async () => {
  const ctx = await setup({ classifier: null });
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);
  const trig = await explicitTrigger(ctx, u, room.id);
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events"));
  await ev.ready;
  ev.executorReady();
  ctx.server.engine.tick();
  const claim = await api(u, ctx.base, `/rooms/${room.id}/triggers/${trig.id}/claim`, {
    method: "POST",
    body: JSON.stringify({ sessionId: ev.sessionId }),
  });
  const runAuth = { authorization: `Bearer ${claim.body.lease.leaseToken}` };

  const q = await api(null, ctx.base, `/rooms/${room.id}/data/query`, {
    method: "POST",
    headers: runAuth,
    body: JSON.stringify({ source: "demo-metrics", metric: "latencyMs", from: "2026-09-17", to: "2026-09-18" }),
  });
  assert.equal(q.status, 200);
  assert.equal(q.body.rows.length, 2);
  assert.match(q.body.note, /[Ss]ynthetic/);

  // bad range rejected; non-lease rejected
  assert.equal(
    (
      await api(null, ctx.base, `/rooms/${room.id}/data/query`, {
        method: "POST",
        headers: runAuth,
        body: JSON.stringify({ source: "demo-metrics", metric: "latencyMs", from: "2026-09-19", to: "2026-09-18" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api(null, ctx.base, `/rooms/${room.id}/data/query`, {
        method: "POST",
        headers: { authorization: u.auth, connection: "close" },
        body: JSON.stringify({ source: "demo-metrics", metric: "latencyMs" }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await api(null, ctx.base, `/rooms/${room.id}/data/query`, {
        method: "POST",
        headers: runAuth,
        body: JSON.stringify({ source: "prod", metric: "latencyMs" }),
      })
    ).status,
    400,
  );
  ev.close();
  await ctx.cleanup();
});

// An explicit request is answered by a real agent, which takes tens of seconds.
// A room that stayed perfectly still for all of them is the rare case, not the
// common one, so act-mode completion has to say which results survive drift:
// a reply writes nothing and does, anything touching the canvas does not.
test("act mode: a reply survives room drift, a mutation still conflicts", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events"));
  await ev.ready;
  ev.executorReady();
  ctx.server.engine.tick();

  const claimed = async (triggerId: string) => {
    const claim = await api(u, ctx.base, `/rooms/${room.id}/triggers/${triggerId}/claim`, {
      method: "POST",
      body: JSON.stringify({ sessionId: ev.sessionId, manual: true }),
    });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    const auth = { authorization: `Bearer ${claim.body.lease.leaseToken}` };
    const context = await api(null, ctx.base, `/rooms/${room.id}/runs/${claim.body.lease.runId}/context`, { headers: auth });
    assert.equal(context.status, 200, JSON.stringify(context.body));
    return { runId: claim.body.lease.runId, auth, revision: context.body.revision };
  };
  const drift = () =>
    api(u, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "meanwhile, someone else talks" }) });
  const complete = (run: { runId: string; auth: Record<string, string>; revision: string }, result: unknown) =>
    api(null, ctx.base, `/rooms/${room.id}/runs/${run.runId}/complete`, {
      method: "POST",
      headers: run.auth,
      body: JSON.stringify({ id: randomUUID(), revision: run.revision, result }),
    });

  const first = await explicitTrigger(ctx, u, room.id);
  assert.equal(first.mode, "act");
  const reply = await claimed(first.id);
  await drift();
  await ctx.server.engine.classifierIdle(room.id);
  const replied = await complete(reply, { kind: "reply", text: "Tomorrow is a Tuesday.", sources: [{ kind: "entry", id: first.causeEntryIds[0] }] });
  assert.equal(replied.status, 200, JSON.stringify(replied.body));
  assert.equal(replied.body.entry.text, "Tomorrow is a Tuesday.");
  assert.equal(ctx.server.engine.listTriggers(room.id).find((t: any) => t.id === first.id)!.status, "done");

  const second = await explicitTrigger(ctx, u, room.id);
  const acting = await claimed(second.id);
  await drift();
  await ctx.server.engine.classifierIdle(room.id);
  const acted = await complete(acting, {
    kind: "act",
    text: "Captured it",
    sources: [{ kind: "entry", id: second.causeEntryIds[0] }],
    operations: [{ type: "add", draft: { type: "concept", label: "too late" } }],
  });
  assert.equal(acted.status, 409, JSON.stringify(acted.body));
  assert.ok(!ctx.server.engine.canvasRecords(room.id).some((r: any) => r.typeName === "shape"));

  ev.close();
});
