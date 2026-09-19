import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { NodeDraftSchema, boundedJson } from "@kan/protocol";
import { api, createRoom, registerUser, setup, ticket, EventsClient } from "./helpers";

test("browser schemas work without Buffer and reject malformed drafts", () => {
  const saved = globalThis.Buffer;
  try {
    (globalThis as unknown as { Buffer: unknown }).Buffer = undefined;
    assert.equal(boundedJson().safeParse({ ok: true }).success, true);
    assert.equal(NodeDraftSchema.safeParse({ type: "chart", title: "Browser", spec: { mark: "bar" }, data: [{ x: 1 }] }).success, true);
  } finally { globalThis.Buffer = saved; }
  for (const spec of [null, 1, [], "chart"]) {
    assert.equal(NodeDraftSchema.safeParse({ type: "chart", title: "x", spec, data: [] }).success, false);
  }
  assert.equal(NodeDraftSchema.safeParse({ type: "table", title: "x", columns: ["a"], rows: [["1", "2"]] }).success, false);
});

test("registration requires 32-byte secret and auth rejects ignored hex suffix", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const id = randomUUID(), secret = randomBytes(32).toString("hex");
  assert.equal((await api(null, ctx.base, "/users/register", { method: "POST", body: JSON.stringify({ userId: id, secret, name: "a" }) })).status, 200);
  assert.equal((await api(null, ctx.base, "/me", { headers: { authorization: `Bearer ${id}.${secret}zz` } })).status, 401);
});

test("HTTP origins and preflight share websocket allowlist", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const res = await fetch(`${ctx.base}/rooms`, { method: "OPTIONS", headers: { origin: "http://localhost:1420", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:1420");
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /authorization/i);
  assert.equal((await fetch(`${ctx.base}/health`, { headers: { origin: "https://evil.example" } })).status, 403);
});

test("chunked upload is capped before EOF without draining and normal upload succeeds", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const response = await new Promise<{ status: number; close: string | undefined }>((resolve, reject) => {
    const req = request(`${ctx.base}/assets`, { method: "POST", headers: { authorization: u.auth, "content-type": "image/png", "transfer-encoding": "chunked" } }, (res) => {
      resolve({ status: res.statusCode!, close: res.headers.connection }); res.resume(); req.destroy();
    });
    req.on("error", (e) => { if (!req.destroyed) reject(e); });
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("server waited for chunked EOF")); });
    req.write(Buffer.alloc(10 * 1024 * 1024 + 1));
  });
  assert.equal(response.status, 413); assert.equal(response.close, "close");
  const normal = await fetch(`${ctx.base}/assets`, { method: "POST", headers: { authorization: u.auth, "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) });
  assert.equal(normal.status, 200);
});

test("streaming body deadline responds 408 without waiting for EOF", { timeout: 9000 }, async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${ctx.base}/users/register`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => { resolve(res.statusCode!); res.resume(); req.destroy(); });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("body deadline did not fire")); });
    req.write("{");
  });
  assert.equal(status, 408);
});

test("pagination rejects noninteger and out-of-range limits", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  for (const endpoint of ["thread", "events"]) for (const limit of ["NaN", "0", "-1", "1.5", "101"]) {
    assert.equal((await api(u, ctx.base, `/rooms/${room.id}/${endpoint}?limit=${limit}`)).status, 400, `${endpoint} ${limit}`);
  }
});

test("replay retains immutable old payload at old cursor", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  const original = (await api(u, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "v1" }) })).body.entry;
  ctx.server.engine.updateEntry({ ...original, text: "v2" });
  const events = ctx.server.engine.eventsSince(room.id, 0, 100).events;
  assert.equal((events[0].entry as { text: string }).text, "v1");
  assert.equal((events[1].entry as { text: string }).text, "v2");
  assert.equal(events[0].entry.seq, events[1].entry.seq);
});

test("asset reuse across rooms retains both rooms' access", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), guest = await registerUser(ctx.base);
  const asset = ctx.server.engine.createAsset(u.id, "image/png", Buffer.from([1]));
  const first = await createRoom(u, ctx.base, { assetIds: [asset.id] });
  await api(guest, ctx.base, "/rooms/join", { method: "POST", body: JSON.stringify({ code: first.code }) });
  await createRoom(u, ctx.base, { assetIds: [asset.id] });
  assert.equal((await fetch(`${ctx.base}/assets/${asset.id}`, { headers: { authorization: guest.auth } })).status, 200);
});

test("duplicate imported messages fail cleanly with no queued ghost or linked assets", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), id = randomUUID();
  const asset = ctx.server.engine.createAsset(u.id, "image/png", Buffer.from([1]));
  const message = { id, text: "ghost", at: new Date().toISOString() };
  const failed = await api(u, ctx.base, "/rooms", { method: "POST", body: JSON.stringify({ localCanvasId: randomUUID(), name: "bad", messages: [message, message], assetIds: [asset.id] }) });
  assert.equal(failed.status, 400);
  assert.equal((await api(u, ctx.base, "/rooms")).body.rooms.length, 0);
  assert.equal((ctx.server.engine as unknown as { broadcastQueue: unknown[] }).broadcastQueue.length, 0);
});

test("supported maximum markdown draft fits a bounded snapshot record", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const draft = { type: "markdown", title: "Large", body: "x".repeat(50_000) };
  assert.equal(NodeDraftSchema.safeParse(draft).success, true);
  const room = await createRoom(u, ctx.base, { records: [{ id: "shape:large", typeName: "shape", type: "kan-node", parentId: "page:page", x: 0, y: 0, rotation: 0, index: "a1", opacity: 1, isLocked: false, meta: {}, props: { w: 320, h: 200, draft } }] });
  assert.equal(ctx.server.engine.canvasSummary(room.id).shapes.length, 1);
});

test("presence expiry closes transport at exact deadline", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events"));
  await ev.ready;
  const closed = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("socket remains open")), 500); ev.ws.once("close", () => { clearTimeout(timer); resolve(); }); });
  ctx.clock.advance(ctx.server.engine.timings.presenceTtlMs); ctx.server.engine.tick();
  await closed;
});
