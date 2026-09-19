import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { api, createRoom, registerUser, setup, ticket, EventsClient } from "./helpers";
import { configFromEnv } from "../src/config";
import { normalizePrivateKey } from "../src/video";

test("replay delivers more than 10000 distinct events before ready", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  const db = ctx.server.engine.db;
  db.exec("BEGIN");
  for (let cursor = 1; cursor <= 10005; cursor++) {
    const entry = { id: randomUUID(), roomId: room.id, seq: cursor, at: new Date().toISOString(), kind: "message", authorId: u.id, text: String(cursor), anchors: [], attachments: [] };
    db.prepare("INSERT INTO events(room_id,cursor,type,entry_id,at,data) VALUES (?,?,?,?,?,?)").run(room.id, cursor, "entry.upsert", entry.id, entry.at, JSON.stringify(entry));
  }
  db.exec("COMMIT");
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events"));
  assert.equal((await ev.ready).cursor, 10005);
  assert.deepEqual(ev.messages.filter((m) => m.type === "event").map((m) => m.event.cursor), Array.from({ length: 10005 }, (_, i) => i + 1));
  ev.close();
});

test("replay overflow closes 1013 without misleading ready", async (t) => {
  const ctx = await setup({ classifier: null, maxSendBuffer: 100 }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  await api(u, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "earlier" }) });
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.server.port()}/events/${room.id}?ticket=${await ticket(u, ctx.base, room.id, "events")}`);
  const messages: unknown[] = []; ws.on("message", (data) => messages.push(JSON.parse(String(data))));
  assert.equal(await new Promise((resolve) => ws.on("close", resolve)), 1013);
  assert.equal(messages.length, 0);
});

test("simultaneous manual claims have exactly one winner and expired partial run retains node", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  await api(u, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant act" }) });
  await ctx.server.engine.classifierIdle(room.id);
  const trigger = ctx.server.engine.listTriggers(room.id)[0];
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events")); await ev.ready;
  ctx.server.engine.setExecutorReady(room.id, ev.sessionId, true, "test");
  const claim = () => api(u, ctx.base, `/rooms/${room.id}/triggers/${trigger.id}/claim`, { method: "POST", body: JSON.stringify({ sessionId: ev.sessionId, manual: true }) });
  const results = await Promise.all([claim(), claim()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const lease = results.find((r) => r.status === 200)!.body.lease;
  const auth = `Bearer ${lease.leaseToken}`;
  const result = ctx.server.engine.mutate(room.id, lease.runId, auth, { id: randomUUID(), operations: [{ type: "add", draft: { type: "concept", label: "retained" } }] });
  ctx.clock.advance(ctx.server.engine.timings.leaseMs); ctx.server.engine.tick();
  assert.equal(ctx.server.engine.listTriggers(room.id)[0].status, "expired");
  assert.ok(ctx.server.engine.canvasRecords(room.id).some((r) => (r as { id: string }).id === result.shapeIds[0]));
  assert.throws(() => ctx.server.engine.heartbeatRun(room.id, lease.runId, auth));
  ctx.server.engine.tick(); assert.equal(ctx.server.engine.listTriggers(room.id)[0].attempt, 1);
});

test("classifier hashes actual state, sanitizes errors, durable queue recovers", async (t) => {
  const ctx = await setup(); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  ctx.classifier.next = () => { throw new Error("private-provider-details"); };
  const id = randomUUID();
  await api(u, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id, text: "a cause" }) });
  await ctx.server.engine.classifierIdle(room.id);
  const row = ctx.server.engine.db.prepare("SELECT state_hash,output FROM decisions WHERE entry_id=?").get(id)!;
  assert.equal(row.state_hash, createHash("sha256").update(JSON.stringify(ctx.classifier.calls[0])).digest("hex"));
  assert.deepEqual(JSON.parse(String(row.output)), { error: "classifier_unavailable" });
  const entry = { id: randomUUID(), roomId: room.id, seq: 2, at: new Date().toISOString(), kind: "message", authorId: u.id, text: "@assistant recover", anchors: [], attachments: [] };
  ctx.server.engine.db.prepare("INSERT INTO entries(room_id,seq,id,kind,author_id,data,at) VALUES (?,?,?,?,?,?,?)").run(room.id, 2, entry.id, "message", u.id, JSON.stringify(entry), entry.at);
  ctx.server.engine.db.prepare("INSERT INTO pending_classification VALUES (?,?)").run(room.id, entry.id);
  ctx.server.engine.start(); await ctx.server.engine.classifierIdle(room.id);
  assert.equal(ctx.server.engine.listTriggers(room.id).length, 1);
  assert.equal(ctx.server.engine.db.prepare("SELECT COUNT(*) n FROM pending_classification").get()!.n, 0);
});

test("environment rejects invalid configuration and defaults classifier disabled", () => {
  assert.equal(configFromEnv({}).classifier, null);
  for (const env of [{ PORT: "0" }, { PORT: "65536" }, { PORT: "1.5" }, { KAN_CLASSIFIER: "unknown" }, { KAN_CLASSIFIER: "jev" }, { KAN_ALLOWED_ORIGINS: "*" }, { VONAGE_APPLICATION_ID: "one" }]) assert.throws(() => configFromEnv(env));
});

test("Vonage private key is accepted as a PEM, an escaped PEM, base64 or a path", (t) => {
  const pem = "-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----\n";
  const directory = mkdtempSync(join(tmpdir(), "kan-key-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "private.key");
  writeFileSync(file, pem);
  for (const form of [pem, pem.replace(/\n/g, "\\n"), Buffer.from(pem).toString("base64"), file]) assert.equal(normalizePrivateKey(form).trimEnd(), pem.trimEnd());
  for (const bad of ["", "   ", "not a key at all"]) assert.throws(() => normalizePrivateKey(bad));
});
