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
});

test("classifier context paths preserve consent and cooldown, failure is graceful", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);

  // addressed above the threshold: a context trigger, never an act one — only
  // an explicit invocation authorizes the assistant to touch the canvas.
  ctx.classifier.next = { triggerProbability: 0.95 };
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "what is up" });
  await ctx.server.engine.classifierIdle(room.id);
  let triggers = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].mode, "context");
  assert.equal(triggers[0].intent, "answer");
  assert.equal(triggers[0].status, "needs_claim"); // no ready executors

  // worth capturing, past the cooldown the first one set
  ctx.clock.advance(ctx.server.engine.timings.cooldownMs);
  ctx.classifier.next = { triggerProbability: 0.9 };
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "we decided X" });
  await ctx.server.engine.classifierIdle(room.id);
  triggers = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 2);
  assert.equal(triggers[1].mode, "context");
  assert.equal(triggers[1].intent, "answer");

  // a second inferred trigger inside the cooldown is suppressed
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "we decided Y too" });
  await ctx.server.engine.classifierIdle(room.id);
  triggers = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 2);

  // classifier error: chat still works, no trigger
  ctx.clock.advance(31_000);
  ctx.classifier.next = () => Promise.reject(new Error("provider down"));
  const ok = await postMsg(ctx, u, room.id, { id: randomUUID(), text: "still works" });
  assert.equal(ok.status, 200);
  await ctx.server.engine.classifierIdle(room.id);
  triggers = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 2);
});

// A conversation that never pauses used to starve the contextual check: each
// message restarted the settle timer, so it never expired. The eagerness preset
// caps that wait, and a cause released by the deadline tolerates the newer
// entries that arrive while the classifier is thinking.
function gatedClassifier(ctx: any, worthCapturing: boolean) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let started!: () => void;
  const first = new Promise<void>((resolve) => { started = resolve; });
  ctx.classifier.next = async () => {
    started();
    await gate;
    return { triggerProbability: worthCapturing ? 0.9 : 0 };
  };
  return { open, first };
}

test("eagerness caps how long a busy room defers the contextual check", async (t) => {
  const ctx = await setup({ timings: { debounceMs: 500 } });
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);

  const patched = await api(u, ctx.base, `/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ assistantEagerness: "insistent" }) });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.room.assistantEagerness, "insistent");

  const { open, first } = gatedClassifier(ctx, true);
  // Insistent allows a 4s deferral. Two messages 3.9s apart leave 100ms of it,
  // so the second is released by the deadline rather than by a silence.
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "we keep talking about the venue" });
  ctx.clock.advance(3_900);
  const causeId = randomUUID();
  await postMsg(ctx, u, room.id, { id: causeId, text: "and the budget too" });
  await first;
  // Still talking while the classifier thinks: this is what used to be "stale".
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "and the sponsors" });
  open();
  await ctx.server.engine.classifierIdle(room.id);

  const status = ctx.server.engine.db.prepare("SELECT status FROM decisions WHERE entry_id=?").get(causeId)!.status;
  assert.equal(status, "swept");
  const triggers = (await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].mode, "context");
});

test("without deadline pressure a superseded cause is still dropped as stale", async (t) => {
  const ctx = await setup({ timings: { debounceMs: 500 } });
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  await api(u, ctx.base, `/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ assistantEagerness: "relaxed" }) });

  const { open, first } = gatedClassifier(ctx, true);
  const causeId = randomUUID();
  await postMsg(ctx, u, room.id, { id: causeId, text: "one question" });
  await first;
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "never mind, moved on" });
  open();
  await ctx.server.engine.classifierIdle(room.id);

  const decision = ctx.server.engine.db.prepare("SELECT status,trigger_id FROM decisions WHERE entry_id=?").get(causeId)!;
  assert.equal(decision.status, "stale");
  assert.equal(decision.trigger_id, null);
});

test("eagerness selects the contextual cooldown and survives a room reload", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  assert.equal((await api(u, ctx.base, `/rooms/${room.id}`)).body.room.assistantEagerness, "eager");

  ctx.classifier.next = { triggerProbability: 0.9 };
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "first cause" });
  await ctx.server.engine.classifierIdle(room.id);
  assert.equal((await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers.length, 1);

  // 20s is past eager's 15s cooldown but inside relaxed's 60s one.
  await api(u, ctx.base, `/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ assistantEagerness: "relaxed" }) });
  ctx.clock.advance(20_000);
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "second cause" });
  await ctx.server.engine.classifierIdle(room.id);
  assert.equal((await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers.length, 1);

  await api(u, ctx.base, `/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ assistantEagerness: "eager" }) });
  await postMsg(ctx, u, room.id, { id: randomUUID(), text: "third cause" });
  await ctx.server.engine.classifierIdle(room.id);
  assert.equal((await api(u, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers.length, 2);
});

test("a settings-only patch does not post a rename entry that would itself be a cause", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  const before = (await api(u, ctx.base, `/rooms/${room.id}/thread`)).body.entries.length;
  await api(u, ctx.base, `/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ assistantEagerness: "insistent" }) });
  await api(u, ctx.base, `/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ assistantPaused: true }) });
  assert.equal((await api(u, ctx.base, `/rooms/${room.id}/thread`)).body.entries.length, before);
  await api(u, ctx.base, `/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) });
  const entries = (await api(u, ctx.base, `/rooms/${room.id}/thread`)).body.entries;
  assert.equal(entries.length, before + 1);
  assert.match(entries[entries.length - 1].text, /renamed the room to "Renamed"/);
});
