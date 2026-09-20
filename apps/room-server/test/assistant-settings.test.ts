import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db";
import { Engine } from "../src/engine";
import { api, createRoom, EventsClient, registerUser, setup, ticket } from "./helpers";

async function post(ctx: Awaited<ReturnType<typeof setup>>, user: Awaited<ReturnType<typeof registerUser>>, roomId: string, text = "Continue the discussion") {
  const result = await api(user, ctx.base, `/rooms/${roomId}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text }) });
  assert.equal(result.status, 200);
  await ctx.server.engine.classifierIdle(roomId);
}

const patch = (ctx: Awaited<ReturnType<typeof setup>>, user: Awaited<ReturnType<typeof registerUser>>, roomId: string, settings: object) => api(user, ctx.base, `/rooms/${roomId}`, { method: "PATCH", body: JSON.stringify(settings) });

test("room settings persist, broadcast, and do not add conversation entries", async (t) => {
  const ctx = await setup({ timings: { debounceMs: 0 } }); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  assert.equal(room.assistantThreshold, 0.5);
  assert.equal(room.assistantCooldownMs, 15000);
  const observer = new EventsClient(ctx.server.port(), room.id, await ticket(user, ctx.base, room.id, "events"));
  t.after(() => observer.close()); await observer.ready;
  const changed = await patch(ctx, user, room.id, { assistantThreshold: 0.65, assistantCooldownMs: 3000 });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.room.assistantThreshold, 0.65);
  assert.equal(changed.body.room.assistantCooldownMs, 3000);
  await observer.waitFor((message) => message.type === "presence" && message.room.assistantThreshold === 0.65 && message.room.assistantCooldownMs === 3000);
  assert.equal(ctx.server.engine.thread(room.id, 0, 100).entries.length, 0);
  const reopened = openDb(join(ctx.dir, "kan.sqlite"));
  try {
    const persisted = new Engine({ db: reopened }).roomDetail(room.id).room;
    assert.equal(persisted.assistantThreshold, 0.65);
    assert.equal(persisted.assistantCooldownMs, 3000);
  } finally { reopened.close(); }
});

test("settings reject invalid bounds and nonmembers, while partial patches preserve the other value", async (t) => {
  const ctx = await setup(); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), stranger = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  for (const invalid of [{ assistantThreshold: -0.01 }, { assistantThreshold: 1.01 }, { assistantThreshold: "0.5" }, { assistantThreshold: null }, { assistantCooldownMs: -1 }, { assistantCooldownMs: 120001 }, { assistantCooldownMs: 1.5 }]) {
    assert.equal((await patch(ctx, user, room.id, invalid)).status, 400);
  }
  assert.equal((await patch(ctx, stranger, room.id, { assistantCooldownMs: 0 })).status, 403);
  assert.equal((await patch(ctx, user, room.id, { assistantThreshold: 0 })).status, 200);
  const updated = await patch(ctx, user, room.id, { assistantCooldownMs: 120000 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.room.assistantThreshold, 0);
  assert.equal(updated.body.room.assistantCooldownMs, 120000);
});

test("each room's threshold controls the same Jev score, including exact boundaries", async (t) => {
  const ctx = await setup({ timings: { debounceMs: 0 } }); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), first = await createRoom(user, ctx.base), second = await createRoom(user, ctx.base);
  ctx.classifier.next = { triggerProbability: 0.6 };
  assert.equal((await patch(ctx, user, first.id, { assistantThreshold: 0.6, assistantCooldownMs: 0 })).status, 200);
  assert.equal((await patch(ctx, user, second.id, { assistantThreshold: 0.59, assistantCooldownMs: 0 })).status, 200);
  await post(ctx, user, first.id); await post(ctx, user, second.id);
  assert.equal(ctx.server.engine.listTriggers(first.id).length, 0);
  assert.equal(ctx.server.engine.listTriggers(second.id).length, 1);
  assert.equal(ctx.server.engine.listTriggers(second.id)[0].mode, "context");
  const decision = ctx.server.engine.db.prepare("SELECT output FROM decisions WHERE room_id=?").get(second.id)!;
  assert.equal(JSON.parse(String(decision.output)).triggerThreshold, 0.59);
});

test("actual cooldown supports zero and releases precisely at the chosen duration", async (t) => {
  const ctx = await setup({ timings: { debounceMs: 0 } }); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  ctx.classifier.next = { triggerProbability: 0.9 };
  assert.equal((await patch(ctx, user, room.id, { assistantCooldownMs: 5000 })).status, 200);
  await post(ctx, user, room.id); await post(ctx, user, room.id);
  assert.equal(ctx.server.engine.listTriggers(room.id).length, 1);
  ctx.clock.advance(4999); await post(ctx, user, room.id);
  assert.equal(ctx.server.engine.listTriggers(room.id).length, 1);
  ctx.clock.advance(1); await post(ctx, user, room.id);
  assert.equal(ctx.server.engine.listTriggers(room.id).length, 2);
  await patch(ctx, user, room.id, { assistantCooldownMs: 0 });
  await post(ctx, user, room.id); await post(ctx, user, room.id);
  assert.equal(ctx.server.engine.listTriggers(room.id).length, 4);
});

test("settings cannot override pause or turn inferred checks into edit authorization", async (t) => {
  const ctx = await setup({ timings: { debounceMs: 0 } }); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  ctx.classifier.next = { triggerProbability: 1 };
  await patch(ctx, user, room.id, { assistantThreshold: 0, assistantCooldownMs: 0, assistantPaused: true });
  await post(ctx, user, room.id);
  assert.equal(ctx.server.engine.listTriggers(room.id).length, 0);
  await patch(ctx, user, room.id, { assistantThreshold: 1, assistantPaused: false });
  await post(ctx, user, room.id);
  assert.equal(ctx.server.engine.listTriggers(room.id).length, 0);
  await post(ctx, user, room.id, "@kan answer this explicit request");
  assert.equal(ctx.server.engine.listTriggers(room.id)[0].mode, "act");
});

test("a settings change while Jev is running applies to that decision", async (t) => {
  const ctx = await setup({ timings: { debounceMs: 0 } });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  t.after(async () => { release(); await ctx.cleanup(); });
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  await patch(ctx, user, room.id, { assistantThreshold: 0.8 });
  ctx.classifier.next = async () => { started(); await gate; return { triggerProbability: 0.6 }; };
  const posted = api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "A useful request" }) });
  await ready;
  assert.equal((await patch(ctx, user, room.id, { assistantThreshold: 0.5 })).status, 200);
  release(); await posted; await ctx.server.engine.classifierIdle(room.id);
  assert.equal(ctx.server.engine.listTriggers(room.id).length, 1);
});

test("migration preserves existing room pacing and data", () => {
  const directory = mkdtempSync(join(tmpdir(), "kan-assistant-settings-")), path = join(directory, "legacy.sqlite");
  let db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT); INSERT INTO meta VALUES ('schema_version','4'); CREATE TABLE rooms(id TEXT PRIMARY KEY,name TEXT,assistant_eagerness TEXT);");
    for (const eagerness of ["relaxed", "balanced", "eager", "insistent"]) db.prepare("INSERT INTO rooms VALUES (?,?,?)").run(eagerness, "Preserved room", eagerness);
    db.close(); db = openDb(path);
    for (const [id, cooldown] of [["relaxed", 60000], ["balanced", 30000], ["eager", 15000], ["insistent", 5000]] as const) {
      const row = db.prepare("SELECT * FROM rooms WHERE id=?").get(id)!;
      assert.equal(row.name, "Preserved room");
      assert.equal(row.assistant_threshold, 0.5);
      assert.equal(row.assistant_cooldown_ms, cooldown);
    }
    assert.equal(db.prepare("SELECT v FROM meta WHERE k='schema_version'").get()!.v, "5");
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
