import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupMockIndexedDB, clearMockIndexedDB } from "./mock-idb";
import {
  createOfflineCanvas,
  getCanvasEntry,
  listLocalCanvases,
  markCanvasOnline,
  touchCanvas,
  deleteCanvasEntry,
  savePublishJournal,
  getPublishJournal,
  clearPublishJournal,
} from "../src/lib/canvas-repository";

beforeEach(() => {
  setupMockIndexedDB();
});

test("canvas catalog lifecycle and ordering", async () => {
  clearMockIndexedDB();

  const c1 = await createOfflineCanvas({ name: "Canvas 1" });
  assert.equal(c1.name, "Canvas 1");
  assert.equal(c1.mode, "offline");
  assert.equal(c1.localPersistenceKey, `kan-room-${c1.id}`);

  const c2 = await createOfflineCanvas({ name: "Canvas 2" });
  assert.equal(c2.name, "Canvas 2");

  const list = await listLocalCanvases();
  assert.equal(list.length, 2);
  // Canvas 2 was created later, so it appears first
  assert.equal(list[0].id, c2.id);
  assert.equal(list[1].id, c1.id);

  // Touching canvas 1 moves it to the front
  await touchCanvas(c1.id);
  const updatedList = await listLocalCanvases();
  assert.equal(updatedList[0].id, c1.id);
});

test("mark canvas online transitions mode and links room", async () => {
  clearMockIndexedDB();
  const c = await createOfflineCanvas({ name: "Draft Diagram" });
  assert.equal(c.mode, "offline");
  assert.equal(c.roomId, undefined);

  const onlineRoomId = crypto.randomUUID();
  const online = await markCanvasOnline(c.id, onlineRoomId, "7K2M9-XP4TR");
  assert.equal(online.mode, "online");
  assert.equal(online.roomId, onlineRoomId);
  assert.equal(online.roomCode, "7K2M9-XP4TR");

  // Lookup by roomId also works
  const retrieved = await getCanvasEntry(onlineRoomId);
  assert.ok(retrieved);
  assert.equal(retrieved.id, c.id);
  assert.equal(retrieved.mode, "online");
});

test("publish journal persistence and clearing", async () => {
  clearMockIndexedDB();
  const canvasId = crypto.randomUUID();

  assert.equal(await getPublishJournal(canvasId), null);

  await savePublishJournal({
    localCanvasId: canvasId,
    backendOrigin: "http://localhost:8787",
    stage: "preparing",
    name: "My Canvas",
    updatedAt: new Date().toISOString(),
  });

  const journal = await getPublishJournal(canvasId);
  assert.ok(journal);
  assert.equal(journal.stage, "preparing");
  assert.equal(journal.name, "My Canvas");

  await clearPublishJournal(canvasId);
  assert.equal(await getPublishJournal(canvasId), null);
});

test("delete canvas entry removes from catalog", async () => {
  clearMockIndexedDB();
  const c = await createOfflineCanvas({ name: "To Delete" });
  assert.ok(await getCanvasEntry(c.id));

  await deleteCanvasEntry(c.id);
  assert.equal(await getCanvasEntry(c.id), null);
});
