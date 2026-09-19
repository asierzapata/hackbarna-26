import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, createRoom, registerUser, setup, ticket, EventsClient, sleep } from "./helpers";
import { mapEvaluationAnswers } from "../src/classifier";

const shape = (id: string, parentId = "page:page") => ({ id, typeName: "shape", type: "kan-node", x: 0, y: 0, rotation: 0, parentId, index: "a1", opacity: 1, isLocked: false, props: { w: 320, h: 200, draft: { type: "concept", label: id } }, meta: {} });
const page = (id: string) => ({ id, typeName: "page", name: "Page", index: "a1", meta: {} });

test("snapshot integrity rejects duplicate ids, dangling parents, cycles, missing assets and unsafe URLs", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const bookmark = { ...shape("shape:link"), type: "bookmark", props: { w: 300, h: 320, url: "javascript:alert(1)", assetId: null } };
  const snapshots = [
    [shape("shape:a"), shape("shape:a")],
    [shape("shape:a", "shape:missing")],
    [shape("shape:a", "shape:b"), shape("shape:b", "shape:a")],
    [{ id: "binding:b", typeName: "binding", type: "arrow", fromId: "shape:missing", toId: "shape:missing", props: { terminal: "start", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" }, meta: {} }],
    [bookmark],
    [{ ...bookmark, props: { ...bookmark.props, url: "data:text/html,<script>" } }],
    [{ ...shape("shape:i"), type: "image", props: { w: 100, h: 100, playing: true, url: "", assetId: "asset:missing", crop: null, flipX: false, flipY: false, altText: "" } }],
  ];
  for (const records of snapshots) {
    const result = await api(u, ctx.base, "/rooms", { method: "POST", body: JSON.stringify({ localCanvasId: randomUUID(), name: "invalid", records }) });
    assert.equal(result.status, 400, JSON.stringify(result.body));
  }
  assert.equal(ctx.server.engine.listRooms(u.id).length, 0);
  const valid = await createRoom(u, ctx.base, { records: [{ ...bookmark, props: { ...bookmark.props, url: "https://example.com" } }] });
  assert.equal(ctx.server.engine.canvasSummary(valid.id).shapes.length, 1);
  const documentOnly = await createRoom(u, ctx.base, { records: [{ id: "document:document", typeName: "document", name: "", gridSize: 10, meta: {} }] });
  assert.equal(ctx.server.engine.canvasRecords(documentOnly.id).filter((r: any) => r.typeName === "document").length, 1);
});

test("geometry uses near page, rejects cross-page connect and mixed-parent arrange atomically", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base, { records: [page("page:page"), page("page:second"), shape("shape:a"), shape("shape:b", "page:second"), shape("shape:child", "shape:a")] });
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events")); await ev.ready;
  await api(u, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant geometry" }) }); await ctx.server.engine.classifierIdle(room.id);
  ctx.server.engine.setExecutorReady(room.id, ev.sessionId, true, "fixture");
  const lease = ctx.server.engine.claimTrigger(u.id, room.id, ctx.server.engine.listTriggers(room.id)[0].id, { sessionId: ev.sessionId, manual: true });
  const mutate = (operations: import("@kan/protocol").Mutation[]) => ctx.server.engine.mutate(room.id, lease.runId, `Bearer ${lease.leaseToken}`, { id: randomUUID(), operations });
  const added = mutate([{ type: "add", nearShapeId: "shape:b", draft: { type: "concept", label: "near" } }]);
  assert.equal((ctx.server.engine.canvasRecords(room.id).find((r: any) => r.id === added.shapeIds[0]) as any).parentId, "page:second");
  const before = ctx.server.engine.canvasRecords(room.id);
  for (const operation of [
    { type: "connect", from: "shape:a", to: "shape:b" },
    { type: "connect", from: "shape:a", to: "shape:child" },
    { type: "arrange", shapeIds: ["shape:a", "shape:b"], layout: "row" },
    { type: "add", nearShapeId: "shape:child", draft: { type: "concept", label: "bad" } },
  ] as import("@kan/protocol").Mutation[]) assert.throws(() => mutate([operation]));
  assert.deepEqual(ctx.server.engine.canvasRecords(room.id), before);
});

test("claimed runs recolor native stars in place and create validated calendar drafts", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base);
  const star = {
    ...shape("shape:star"), type: "geo",
    props: { geo: "star", color: "black", labelColor: "black", fill: "none", dash: "draw", size: "m", font: "draw", align: "middle", verticalAlign: "middle", growY: 0, url: "", scale: 1, w: 200, h: 200, flipX: false, flipY: false, richText: { type: "doc", content: [{ type: "paragraph" }] } },
  };
  const room = await createRoom(user, ctx.base, { records: [page("page:page"), star, { ...star, id: "shape:locked", isLocked: true }] });
  const events = new EventsClient(ctx.server.port(), room.id, await ticket(user, ctx.base, room.id, "events"));
  t.after(() => events.close()); await events.ready;
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@kan make the star blue and add a calendar" }) });
  ctx.server.engine.setExecutorReady(room.id, events.sessionId, true, "fixture");
  const lease = ctx.server.engine.claimTrigger(user.id, room.id, ctx.server.engine.listTriggers(room.id)[0].id, { sessionId: events.sessionId, manual: true });
  const mutate = (operations: unknown[]) => api(null, ctx.base, `/rooms/${room.id}/runs/${lease.runId}/mutate`, { method: "POST", headers: { authorization: `Bearer ${lease.leaseToken}` }, body: JSON.stringify({ id: randomUUID(), operations }) });
  const draft = { type: "calendar", title: "Calendar", events: [], month: "2026-09", selectedDate: "2026-09-20" };
  const result = await mutate([{ type: "style", shapeId: star.id, color: "blue" }, { type: "add", draft }]);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const records = ctx.server.engine.canvasRecords(room.id) as any[];
  assert.deepEqual(records.find((record) => record.id === star.id).props, { ...star.props, color: "blue" });
  const calendar = records.find((record) => record.id === result.body.shapeIds[1]);
  assert.equal(calendar.type, "kan-node");
  assert.deepEqual(calendar.props, { w: 520, h: 560, draft });
  for (const operation of [
    { type: "style", shapeId: star.id, color: "not-a-color" },
    { type: "style", shapeId: "shape:locked", color: "red" },
    { type: "style", shapeId: calendar.id, color: "red" },
    { type: "add", draft: { ...draft, selectedDate: "2026-02-30" } },
  ]) assert.equal((await mutate([operation])).status, 400);
  assert.deepEqual(ctx.server.engine.canvasRecords(room.id), records);
});

test("storage and SQL rollback discard queued events; invalid publish cleans handle", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  ctx.server.engine.db.exec("CREATE TEMP TRIGGER fail_entry BEFORE INSERT ON entries WHEN json_extract(NEW.data,'$.text')='reject' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(() => ctx.server.engine.publishRoom(u, { localCanvasId: randomUUID(), name: "fault", messages: [{ id: randomUUID(), text: "ghost", at: new Date().toISOString() }, { id: randomUUID(), text: "reject", at: new Date().toISOString() }] }));
  const internal = ctx.server.engine as unknown as { broadcastQueue: unknown[]; rooms: Map<string, unknown> };
  assert.equal(internal.broadcastQueue.length, 0); assert.equal(internal.rooms.size, 0);
  const room = await createRoom(u, ctx.base);
  assert.throws(() => ctx.server.engine.postMessage(u, room.id, { id: randomUUID(), text: "reject" }));
  ctx.server.engine.postMessage(u, room.id, { id: randomUUID(), text: "real" });
  assert.deepEqual(ctx.server.engine.eventsSince(room.id, 0, 100).events.map((e) => e.entry.kind === "message" && e.entry.text), ["real"]);
});

test("failed credential throttling ignores spoofed headers and is per server", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  for (let i = 0; i < 20; i++) assert.equal((await api(null, ctx.base, "/me", { headers: { authorization: `Bearer ${u.id}.${"0".repeat(64)}`, "x-kan-client-ip": `spoof-${i}`, "x-forwarded-for": `10.0.0.${i}` } })).status, 401);
  assert.equal((await api(u, ctx.base, "/me", { headers: { "x-kan-client-ip": "different" } })).status, 429);
  const other = await setup({ classifier: null }); t.after(() => other.cleanup());
  const user = await registerUser(other.base); assert.equal((await api(user, other.base, "/me")).status, 200);
});

test("join and rename broadcast membership, messages update recent history", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), guest = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events")); await ev.ready;
  ctx.clock.advance(1000); ctx.server.engine.joinRoom(guest.id, room.code);
  await ev.waitFor((m) => m.type === "presence" && m.members.some((member: any) => member.id === guest.id));
  ctx.server.engine.renameUser(guest.id, "Updated");
  await ev.waitFor((m) => m.type === "presence" && m.members.some((member: any) => member.name === "Updated"));
  assert.ok(ctx.server.engine.listRooms(guest.id)[0].lastOpenedAt);
  ctx.server.engine.postMessage(u, room.id, { id: randomUUID(), text: "recent" });
  assert.notEqual(ctx.server.engine.roomDetail(room.id).room.updatedAt, room.updatedAt);
});

test("classifier database failure rolls trigger and decision back while retaining pending cause", async (t) => {
  const ctx = await setup(); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  ctx.server.engine.db.exec("CREATE TEMP TRIGGER fail_decision BEFORE INSERT ON decisions BEGIN SELECT RAISE(ABORT,'fixture decision failure'); END");
  ctx.classifier.next = { addressedProbability: 0, worthCapturingProbability: 1, intent: "capture", intentProbability: 1, relatedShapeId: null, needsExternalDataProbability: 0, captureScore: 4 };
  const id = randomUUID();
  const response = await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id, text: "We decided to use SQLite" }) });
  assert.equal(response.status, 200);
  await assert.rejects(ctx.server.engine.classifierIdle(room.id), /fixture decision failure/);
  assert.equal(ctx.server.engine.listTriggers(room.id).length, 0);
  assert.equal(ctx.server.engine.db.prepare("SELECT COUNT(*) n FROM decisions").get()!.n, 0);
  assert.equal(ctx.server.engine.db.prepare("SELECT COUNT(*) n FROM pending_classification WHERE entry_id=?").get(id)!.n, 1);
  assert.equal(ctx.server.engine.eventsSince(room.id, 0, 100).events.length, 1);
  ctx.server.engine.db.exec("DROP TRIGGER fail_decision");
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "The SQLite decision is confirmed" }) });
  await ctx.server.engine.classifierIdle(room.id);
  assert.equal(ctx.server.engine.listTriggers(room.id).length, 1);
  ctx.server.engine.enqueueClassification(room.id, ctx.server.engine.getEntry(room.id, id)!);
  await ctx.server.engine.classifierIdle(room.id);
  assert.equal(ctx.server.engine.db.prepare("SELECT COUNT(*) n FROM pending_classification WHERE entry_id=?").get(id)!.n, 0);
});

test("classifier context filters open suggestions before limiting and hashes explicit cause state", async (t) => {
  const ctx = await setup(); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  for (let i = 1; i <= 25; i++) {
    const entry = { id: randomUUID(), roomId: room.id, seq: i, at: new Date().toISOString(), kind: "suggestion", triggerId: randomUUID(), runId: randomUUID(), draft: { type: "concept", label: String(i) }, status: i === 1 ? "open" : "dismissed", shapeId: null };
    ctx.server.engine.db.prepare("INSERT INTO entries(room_id,seq,id,kind,data,at) VALUES (?,?,?,?,?,?)").run(room.id, i, entry.id, entry.kind, JSON.stringify(entry), entry.at);
  }
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "normal" }) }); await ctx.server.engine.classifierIdle(room.id);
  assert.equal(ctx.classifier.calls[0].openSuggestions.length, 1);
  assert.equal(ctx.classifier.calls[0].recentResolvedContributions?.length, 20);
  assert.ok(ctx.classifier.calls[0].recentResolvedContributions?.every((entry) => (entry as { status: string }).status === "dismissed"));
  const id = randomUUID(); await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id, text: "@assistant latest" }) }); await ctx.server.engine.classifierIdle(room.id);
  const hashes = ctx.server.engine.db.prepare("SELECT state_hash,status FROM decisions ORDER BY rowid").all();
  assert.notEqual(hashes[0].state_hash, hashes[1].state_hash); assert.equal(hashes[1].status, "explicit");
  assert.equal(ctx.classifier.calls.length, 1);
});

test("classifier rejects malformed related shape choices and any bad probability", () => {
  const state = { cause: { id: "id", kind: "message" as const, text: "", authorId: "u" }, recentEntries: [], shapes: [{ id: "shape:a", label: "a" }], openSuggestions: [] };
  const answers = { addressed: { probability: 0 }, worthCapturing: { probability: 0 }, intent: { choice: "answer", probabilities: { answer: 1 } }, relatedShape: { choice: "shape_0", probabilities: { shape_0: 1 } }, needsExternalData: { probability: 0 }, captureWish: { score: 0 } };
  for (const choice of ["shape_00", "shape_1", "shape_-1", "shape_0x", "shape_1.5"]) assert.throws(() => mapEvaluationAnswers({ ...answers, relatedShape: { ...answers.relatedShape, choice } }, state));
  assert.throws(() => mapEvaluationAnswers({ ...answers, intent: { choice: "answer", probabilities: { answer: 1, none: 3 } } }, state));
});
