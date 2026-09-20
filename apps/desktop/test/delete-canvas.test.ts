import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupMockIndexedDB } from "./mock-idb";
import {
  createOfflineCanvas,
  getCanvasEntry,
  getPublishJournal,
  markCanvasOnline,
  savePublishJournal,
} from "../src/lib/canvas-repository";
import { localThreadStorage } from "../src/lib/local-thread-store";
import { completeOnboarding } from "../src/lib/onboarding";
import { deleteCanvas } from "../src/lib/delete-canvas";

const TLDRAW_DB_NAME_INDEX = "TLDRAW_DB_NAME_INDEX_v2";

/** Enough of the Storage API for the tldraw database-name registry. */
function setupMockLocalStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
    writable: true,
    configurable: true,
  });
  return data;
}

function threadEntry(text: string) {
  return {
    id: crypto.randomUUID(),
    roomId: crypto.randomUUID(),
    seq: 1,
    at: "2026-09-19T12:00:00.000Z",
    kind: "message" as const,
    text,
    authorId: crypto.randomUUID(),
    anchors: [],
    attachments: [],
  };
}

beforeEach(() => setupMockIndexedDB());

test("deleting an offline canvas removes every local trace without contacting the server", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network request");
  });
  const canvas = await createOfflineCanvas({ name: "Sketch" });
  await localThreadStorage.write(canvas.id, [threadEntry("hello")]);
  await savePublishJournal({
    localCanvasId: canvas.id,
    backendOrigin: "https://example.test",
    stage: "preparing",
    name: "Sketch",
    updatedAt: "2026-09-19T12:00:00.000Z",
  });
  const store = setupMockLocalStorage({
    [TLDRAW_DB_NAME_INDEX]: JSON.stringify([
      `TLDRAW_DOCUMENT_v2${canvas.localPersistenceKey}`,
      "TLDRAW_DOCUMENT_v2kan-room-other",
    ]),
  });
  const deleted: string[] = [];
  const realDelete = indexedDB.deleteDatabase.bind(indexedDB);
  t.mock.method(indexedDB, "deleteDatabase", (name: string) => {
    deleted.push(name);
    return realDelete(name);
  });

  await deleteCanvas(canvas.id, "offline");

  assert.equal(await getCanvasEntry(canvas.id), null);
  assert.deepEqual(await localThreadStorage.read(canvas.id), []);
  assert.equal(await getPublishJournal(canvas.id), null);
  assert.deepEqual(deleted, [`TLDRAW_DOCUMENT_v2${canvas.localPersistenceKey}`]);
  assert.deepEqual(JSON.parse(store.get(TLDRAW_DB_NAME_INDEX)!), [
    "TLDRAW_DOCUMENT_v2kan-room-other",
  ]);
});

test("deleting one offline canvas leaves the others alone", async () => {
  setupMockLocalStorage();
  const kept = await createOfflineCanvas({ name: "Kept" });
  const doomed = await createOfflineCanvas({ name: "Doomed" });
  await localThreadStorage.write(kept.id, [threadEntry("still here")]);

  await deleteCanvas(doomed.id, "offline");

  assert.deepEqual(await getCanvasEntry(kept.id), kept);
  assert.equal((await localThreadStorage.read(kept.id)).length, 1);
});

test("offline delete refuses a missing canvas and one that has since gone online", async () => {
  setupMockLocalStorage();
  await assert.rejects(deleteCanvas("missing", "offline"), /not found/i);

  const canvas = await createOfflineCanvas({ name: "Published" });
  const online = await markCanvasOnline(canvas.id, "room-fixture", "ROOMCODE12");
  await assert.rejects(deleteCanvas(canvas.id, "offline"), /online/i);
  assert.deepEqual(await getCanvasEntry(canvas.id), online);
});

test("leaving an online canvas posts to the server and then drops the local cache", async (t) => {
  setupMockLocalStorage();
  await completeOnboarding("Tester");
  const canvas = await createOfflineCanvas({ name: "Shared" });
  await markCanvasOnline(canvas.id, "room-fixture", "ROOMCODE12");
  await localThreadStorage.write(canvas.id, [threadEntry("shared")]);

  const calls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, options?: RequestInit) => {
      calls.push(`${options?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return Response.json({ ok: true });
    },
  );

  await deleteCanvas("room-fixture", "online");

  assert.ok(calls.includes("POST /rooms/room-fixture/leave"), calls.join(", "));
  assert.equal(await getCanvasEntry(canvas.id), null);
  assert.deepEqual(await localThreadStorage.read(canvas.id), []);
});

test("a failed leave keeps the canvas in the catalog", async (t) => {
  setupMockLocalStorage();
  await completeOnboarding("Tester");
  const canvas = await createOfflineCanvas({ name: "Shared" });
  const cached = await markCanvasOnline(canvas.id, "room-fixture", "ROOMCODE12");
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, options?: RequestInit) =>
      Response.json(
        {},
        { status: String(input).endsWith("/leave") && options?.method === "POST" ? 403 : 200 },
      ),
  );

  await assert.rejects(deleteCanvas("room-fixture", "online"), /403/);
  assert.deepEqual(await getCanvasEntry(canvas.id), cached);
});

test("leaving a room this device never cached is not an error", async (t) => {
  setupMockLocalStorage();
  await completeOnboarding("Tester");
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));

  await deleteCanvas("server-only", "online");

  assert.equal(await getCanvasEntry("server-only"), null);
});
