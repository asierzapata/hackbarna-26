import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { api, createRoom, registerUser, setup, sleep, ticket, EventsClient } from "./helpers";

function wsConnect(url: string, origin?: string): Promise<{ ok: boolean; ws?: WebSocket; messages?: any[] }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { headers: { origin } } : undefined);
    const messages: any[] = [];
    const to = setTimeout(() => resolve({ ok: false }), 3000);
    ws.on("open", () => {
      clearTimeout(to);
      resolve({ ok: true, ws, messages });
    });
    ws.on("message", (d) => messages.push(JSON.parse(String(d))));
    ws.on("error", () => {
      clearTimeout(to);
      resolve({ ok: false });
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(to);
      resolve({ ok: false });
    });
  });
}

test("socket tickets: one-use, channel-bound, expiring", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);
  const port = ctx.server.port();

  const t1 = await ticket(u, ctx.base, room.id, "events");
  const c1 = await wsConnect(`ws://127.0.0.1:${port}/events/${room.id}?ticket=${t1}`);
  assert.equal(c1.ok, true);
  c1.ws?.close();
  // reuse rejected
  const c2 = await wsConnect(`ws://127.0.0.1:${port}/events/${room.id}?ticket=${t1}`);
  assert.equal(c2.ok, false);

  // cross-channel rejected
  const t2 = await ticket(u, ctx.base, room.id, "events");
  const c3 = await wsConnect(`ws://127.0.0.1:${port}/sync/${room.id}?ticket=${t2}`);
  assert.equal(c3.ok, false);

  // expired rejected (consumed only after checks: expiry checked before use)
  const t3 = await ticket(u, ctx.base, room.id, "events");
  ctx.clock.advance(31_000);
  const c4 = await wsConnect(`ws://127.0.0.1:${port}/events/${room.id}?ticket=${t3}`);
  assert.equal(c4.ok, false);

  // bogus ticket rejected
  const c5 = await wsConnect(`ws://127.0.0.1:${port}/events/${room.id}?ticket=zzz`);
  assert.equal(c5.ok, false);
});

test("origin allowlist enforced on upgrade; no-origin clients allowed", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);
  const port = ctx.server.port();
  const t1 = await ticket(u, ctx.base, room.id, "events");

  const bad = await wsConnect(`ws://127.0.0.1:${port}/events/${room.id}?ticket=${t1}`, "https://evil.example");
  assert.equal(bad.ok, false);

  const t2 = await ticket(u, ctx.base, room.id, "events");
  const good = await wsConnect(`ws://127.0.0.1:${port}/events/${room.id}?ticket=${t2}`, "http://localhost:1420");
  assert.equal(good.ok, true);
  good.ws?.close();
});

test("events socket rejects unknown message kinds and replays without gaps", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);
  await api(u, ctx.base, `/rooms/${room.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ id: randomUUID(), text: "earlier" }),
  });
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events"), 0);
  const ready = await ev.ready;
  assert.ok(ready.cursor >= 1);
  // replayed event arrived before ready
  assert.equal(ev.messages[0].type, "event");
  assert.equal(ev.messages[0].event.entry.text, "earlier");
  assert.ok(ready.sessionId);

  // unknown kind -> closed
  ev.send({ type: "admin.takeover" });
  await new Promise((r) => ev.ws.on("close", r));
});

test("events socket live events have no replay/live gap", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base);
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events"));
  await ev.ready;
  await api(u, ctx.base, `/rooms/${room.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ id: randomUUID(), text: "live one" }),
  });
  const msg = await ev.waitFor((m) => m.type === "event" && m.event?.entry?.text === "live one");
  assert.ok(msg.event.cursor > 0);
  ev.close();
});

test("oversized JSON bodies rejected", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const res = await api(u, ctx.base, "/rooms", {
    method: "POST",
    body: JSON.stringify({ localCanvasId: randomUUID(), name: "x".repeat(2000) }),
  });
  assert.equal(res.status, 400); // schema rejects before size matters
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${ctx.base}/rooms`, { method: "POST", headers: { authorization: u.auth, "content-type": "application/json", "content-length": String(9 * 1024 * 1024) } }, (res) => { resolve(res.statusCode!); res.resume(); req.destroy(); });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("body limit response timed out")); });
    req.flushHeaders();
  });
  assert.equal(status, 413);
});

test("video token: stub provider, one session per room, identity in connection data, 503 when unconfigured", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base, "Vera");
  const room = await createRoom(u, ctx.base);
  const [t1, t2] = await Promise.all([
    api(u, ctx.base, `/rooms/${room.id}/video-token`),
    api(u, ctx.base, `/rooms/${room.id}/video-token`),
  ]);
  assert.equal(t1.status, 200);
  assert.equal(t2.status, 200);
  assert.equal(t1.body.sessionId, t2.body.sessionId);
  assert.equal(t1.body.applicationId, "test-application");
  assert.equal(ctx.video.sessions, 1);
  assert.ok(t1.body.token.includes(u.id));
  assert.ok(t1.body.token.includes("Vera"));

  // unconfigured -> 503
  const ctx2 = await setup({ classifier: null, video: null });
  const u2 = await registerUser(ctx2.base);
  const room2 = await createRoom(u2, ctx2.base);
  const unconfigured = await api(u2, ctx2.base, `/rooms/${room2.id}/video-token`);
  assert.equal(unconfigured.status, 503);
  await ctx2.cleanup();
});

test("video provider failure -> 502 and does not block room creation", async (t) => {
  const ctx = await setup({
    classifier: null,
    video: {
      applicationId: "test-application",
      createSession: () => Promise.reject(new Error("provider exploded with secret details")),
      generateClientToken: () => "x",
    },
  });
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const room = await createRoom(u, ctx.base); // room creation unaffected
  assert.ok(room.id);
  const failed = await api(u, ctx.base, `/rooms/${room.id}/video-token`);
  assert.equal(failed.status, 502);
  assert.ok(!JSON.stringify(failed.body).includes("secret details"));
});
