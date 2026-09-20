import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openDb } from "../src/db";
import { Engine } from "../src/engine";
import { createRoomServer } from "../src/server";
import { setup, registerUser, createRoom, api } from "./helpers";

test("legacy migrations backfill event payload, asset membership, and assistant state", () => {
  const dir = mkdtempSync(join(tmpdir(), "kan-migrate-")); const path = join(dir, "fixture.sqlite");
  let db = openDb(path);
  try {
    const userId = randomUUID(), roomId = randomUUID(), assetId = randomUUID(), entryId = randomUUID(), at = new Date().toISOString();
    db.prepare("INSERT INTO rooms(id,local_canvas_id,name,code,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(roomId, randomUUID(), "legacy", "1234567890", userId, at, at);
    db.prepare("INSERT INTO assets(id,owner_id,room_id,content_type,size,data,created_at) VALUES (?,?,?,?,?,?,?)").run(assetId, userId, roomId, "image/png", 1, Buffer.from([1]), at);
    const entry = { id: entryId, roomId, seq: 1, at, kind: "message", authorId: userId, text: "latest available legacy payload", anchors: [], attachments: [] };
    db.prepare("INSERT INTO entries(room_id,seq,id,kind,data,at) VALUES (?,?,?,?,?,?)").run(roomId, 1, entryId, "message", JSON.stringify(entry), at);
    db.prepare("INSERT INTO events(room_id,cursor,type,entry_id,at,data) VALUES (?,?,?,?,?,?)").run(roomId, 1, "entry.upsert", entryId, at, null);
    db.exec("DROP TABLE asset_rooms; DROP TABLE pending_classification; ALTER TABLE events DROP COLUMN data; ALTER TABLE rooms DROP COLUMN assistant_paused; ALTER TABLE rooms DROP COLUMN assistant_eagerness; ALTER TABLE runs DROP COLUMN context; UPDATE meta SET v='1' WHERE k='schema_version'");
    db.close(); db = openDb(path);
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get()!.v, "4");
    assert.equal(db.prepare("SELECT assistant_eagerness FROM rooms WHERE id=?").get(roomId)!.assistant_eagerness, "eager");
    assert.equal(db.prepare("SELECT room_id FROM asset_rooms WHERE asset_id=?").get(assetId)!.room_id, roomId);
    assert.deepEqual(new Engine({ db }).eventsSince(roomId, 0, 100).events[0].entry, entry);
  } finally { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
});

test("durable classification interrupted before decision recovers once after authority restart", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ctx = await setup({ classifier: { decide: async () => { await gate; return { addressedProbability: 1, worthCapturingProbability: 0, intent: "answer", intentProbability: 1, relatedShapeId: null, needsExternalDataProbability: 0, captureScore: 0 }; } } });
  t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "recover this" }) });
  assert.equal(ctx.server.engine.db.prepare("SELECT COUNT(*) n FROM pending_classification").get()!.n, 1);
  const stop = ctx.server.close(); release(); await stop;
  const db = openDb(join(ctx.dir, "kan.sqlite"));
  const server = createRoomServer({ db, classifier: ctx.classifier, timings: { tickMs: 0 } });
  try {
    server.engine.start(); await server.engine.classifierIdle(room.id);
    server.engine.start(); await server.engine.classifierIdle(room.id);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM decisions").get()!.n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM pending_classification").get()!.n, 0);
    assert.equal(ctx.classifier.calls.length, 1);
  } finally { await server.close(); db.close(); }
});
