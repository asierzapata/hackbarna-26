import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { api, createRoom, EventsClient, registerUser, setup, stubVideo, ticket } from "./helpers";

test("captions start only for room members and concurrent starts share a request", async (t) => {
  let starts = 0;
  const ctx = await setup({ classifier: null, video: { ...stubVideo(), async startCaptions() { starts++; await new Promise((resolve) => setTimeout(resolve, 20)); } } });
  t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), outsider = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  const path = `/rooms/${room.id}/captions`;
  assert.equal((await api(outsider, ctx.base, path, { method: "POST" })).status, 403);
  const responses = await Promise.all([api(user, ctx.base, path, { method: "POST" }), api(user, ctx.base, path, { method: "POST" })]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(starts, 1);
  ctx.clock.advance(11_000);
  assert.equal((await api(user, ctx.base, path, { method: "POST" })).status, 200);
  assert.equal(starts, 2);
});

test("caption failures are sanitized, retryable, and do not break video tokens", async (t) => {
  let fail = true;
  const ctx = await setup({ classifier: null, video: { ...stubVideo(), async startCaptions() { if (fail) throw new Error("private provider details"); } } });
  t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  const response = await api(user, ctx.base, `/rooms/${room.id}/captions`, { method: "POST" });
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(response.body), /private provider/);
  assert.equal((await api(user, ctx.base, `/rooms/${room.id}/video-token`)).status, 200);
  fail = false;
  assert.equal((await api(user, ctx.base, `/rooms/${room.id}/captions`, { method: "POST" })).status, 200);
});

test("partial captions are shared, revised, attributed by the server, and finalized exactly once", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base, "Speaker"), room = await createRoom(user, ctx.base);
  const observer = await registerUser(ctx.base, "Listener");
  await api(observer, ctx.base, "/rooms/join", { method: "POST", body: JSON.stringify({ code: room.code }) });
  const speaker = new EventsClient(ctx.server.port(), room.id, await ticket(user, ctx.base, room.id, "events"));
  const listener = new EventsClient(ctx.server.port(), room.id, await ticket(observer, ctx.base, room.id, "events"));
  t.after(() => { speaker.ws.close(); listener.ws.close(); });
  await Promise.all([speaker.ready, listener.ready]);
  const id = randomUUID();
  speaker.send({ type: "transcript", id, text: "This", isFinal: false });
  const first = await listener.waitFor((message) => message.type === "transcript" && message.caption?.text === "This");
  assert.equal(first.caption.authorId, user.id);
  assert.equal(first.caption.id, id);
  assert.equal(ctx.server.engine.getEntry(room.id, id), null);
  ctx.clock.advance(100);
  speaker.send({ type: "transcript", id, text: "This is live", isFinal: false });
  await listener.waitFor((message) => message.type === "transcript" && message.caption?.text === "This is live");
  const late = new EventsClient(ctx.server.port(), room.id, await ticket(observer, ctx.base, room.id, "events"));
  t.after(() => late.ws.close());
  assert.equal((await late.ready).transcripts[0].text, "This is live");
  speaker.send({ type: "transcript", id, text: "This is live.", isFinal: true });
  const final = await listener.waitFor((message) => message.type === "event" && message.event.entry.id === id);
  assert.equal(final.event.entry.source, "transcript");
  assert.equal(final.event.entry.text, "This is live.");
  await speaker.waitFor((message) => message.type === "transcript.ack" && message.id === id);
  speaker.send({ type: "transcript", id, text: "This is live.", isFinal: true });
  speaker.send({ type: "transcript", id, text: "stale partial", isFinal: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(listener.messages.filter((message) => message.type === "event" && message.event.entry.id === id).length, 1);
  assert.equal(ctx.server.engine.getEntry(room.id, id)?.kind, "message");
  ctx.clock.advance(100);
  const nextId = randomUUID();
  speaker.send({ type: "transcript", id: nextId, text: "unfinished", isFinal: false });
  await listener.waitFor((message) => message.type === "transcript" && message.caption?.id === nextId);
  listener.messages.length = 0;
  speaker.ws.close();
  await listener.waitFor((message) => message.type === "transcript" && message.sessionId === speaker.sessionId && message.caption === null);
  assert.equal(ctx.server.engine.getEntry(room.id, nextId), null);
});

test("captions cannot impersonate another speaker or escape their room, and abandoned partials expire", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const alice = await registerUser(ctx.base, "Alice"), bob = await registerUser(ctx.base, "Bob"), room = await createRoom(alice, ctx.base), otherRoom = await createRoom(bob, ctx.base);
  await api(bob, ctx.base, "/rooms/join", { method: "POST", body: JSON.stringify({ code: room.code }) });
  const speaker = new EventsClient(ctx.server.port(), room.id, await ticket(alice, ctx.base, room.id, "events"));
  const peer = new EventsClient(ctx.server.port(), room.id, await ticket(bob, ctx.base, room.id, "events"));
  const outside = new EventsClient(ctx.server.port(), otherRoom.id, await ticket(bob, ctx.base, otherRoom.id, "events"));
  t.after(() => { speaker.ws.close(); peer.ws.close(); outside.ws.close(); });
  await Promise.all([speaker.ready, peer.ready, outside.ready]);
  const id = randomUUID();
  speaker.send({ type: "transcript", id, text: "Alice is speaking", isFinal: false });
  await peer.waitFor((message) => message.type === "transcript" && message.caption?.id === id);
  peer.send({ type: "transcript", id, text: "Not Alice", isFinal: true });
  await peer.waitFor((message) => message.type === "transcript.error" && message.id === id);
  assert.equal(ctx.server.engine.getEntry(room.id, id), null);
  assert.equal(outside.messages.some((message) => message.type === "transcript"), false);
  ctx.clock.advance(15_001);
  ctx.server.engine.tick();
  await peer.waitFor((message) => message.type === "transcript" && message.sessionId === speaker.sessionId && message.caption === null);
  assert.equal(ctx.server.engine.getEntry(room.id, id), null);
  assert.equal(outside.messages.some((message) => message.type === "transcript"), false);
});

test("the caption service receives a server-only moderator token while clients remain publishers", async (t) => {
  const roles: string[] = [];
  const ctx = await setup({ classifier: null, video: {
    ...stubVideo(),
    generateClientToken(_session, options) { roles.push(options.role); return `fixture-${options.role}`; },
    async startCaptions(_session, token) { assert.equal(token, "fixture-moderator"); },
  } });
  t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  const response = await api(user, ctx.base, `/rooms/${room.id}/captions`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { started: true });
  assert.ok(roles.includes("moderator"));
  assert.equal((await api(user, ctx.base, `/rooms/${room.id}/video-token`)).body.token, "fixture-publisher");
});
