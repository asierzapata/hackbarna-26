import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupMockIndexedDB, clearMockIndexedDB } from "./mock-idb";
import {
  consumeCanvasInitialRecords,
  createOfflineCanvas,
  getCanvasEntry,
} from "../src/lib/canvas-repository";
import { completeOnboarding } from "../src/lib/onboarding";
import { publishCanvas } from "../src/lib/publish-canvas";
import { duplicateOnlineToOffline } from "../src/lib/duplicate-canvas";

beforeEach(() => {
  setupMockIndexedDB();
});

test("publishCanvas acquires lock and prevents concurrent publish", async () => {
  clearMockIndexedDB();
  await completeOnboarding("Tester");
  const canvas = await createOfflineCanvas({ name: "Concurrent Test" });

  // Simulate an ongoing publish lock by mocking global fetch to hang
  const originalFetch = globalThis.fetch;
  let releaseFetch: () => void;
  const fetchPromise = new Promise<Response>((resolve) => {
    releaseFetch = () => resolve(new Response(JSON.stringify({ user: { id: "u1", name: "Tester" } }), { status: 200 }));
  });

  globalThis.fetch = () => fetchPromise;

  try {
    const p1 = publishCanvas({ localCanvasId: canvas.id });
    // Second concurrent call should fail immediately
    await assert.rejects(
      publishCanvas({ localCanvasId: canvas.id }),
      /A publish operation is already in progress/
    );

    releaseFetch!();
    // Allow p1 to reject gracefully since mock fetch doesn't handle all endpoints
    await p1.catch(() => {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("duplicateOnlineToOffline creates an independent offline copy", async () => {
  clearMockIndexedDB();
  await completeOnboarding("Tester");

  const originalFetch = globalThis.fetch;
  const mockRoomId = crypto.randomUUID();

  // Mock server endpoints for canvas and assets
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/canvas")) {
      return new Response(
        JSON.stringify({
          records: [
            { id: "document:doc1", typeName: "document" },
            { id: "page:p1", typeName: "page" },
            {
              id: "shape:s1",
              typeName: "shape",
              type: "kan-node",
              x: 10,
              y: 10,
              props: { draft: { type: "concept", label: "Idea" } },
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const duplicated = await duplicateOnlineToOffline({
      roomId: mockRoomId,
      sourceName: "Team Roadmap",
    });

    assert.equal(duplicated.name, "Team Roadmap (copy)");
    assert.equal(duplicated.mode, "offline");
    assert.notEqual(duplicated.id, mockRoomId);
    assert.equal(duplicated.roomId, undefined);

    // Verify copy is stored in local catalog
    const inCatalog = await getCanvasEntry(duplicated.id);
    assert.ok(inCatalog);
    assert.equal(inCatalog.name, "Team Roadmap (copy)");
    assert.equal(inCatalog.mode, "offline");

    const durableRecords = await consumeCanvasInitialRecords(duplicated.id);
    assert.equal(durableRecords?.length, 3);
    assert.equal(await consumeCanvasInitialRecords(duplicated.id), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
