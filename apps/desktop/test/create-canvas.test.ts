import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupMockIndexedDB, clearMockIndexedDB } from "./mock-idb";
import {
  getCanvasEntry,
  listLocalCanvases,
} from "../src/lib/canvas-repository";
import { completeOnboarding } from "../src/lib/onboarding";
import { createCanvas } from "../src/lib/create-canvas";

beforeEach(() => {
  setupMockIndexedDB();
});

test("an offline canvas is created locally and never contacts the server", async () => {
  clearMockIndexedDB();
  await completeOnboarding("Tester");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("the offline path must not reach the network");
  };

  try {
    const created = await createCanvas("offline", "  Sketchbook  ");
    assert.equal(created.mode, "offline");
    assert.equal(created.roomId, undefined);

    const entry = await getCanvasEntry(created.localCanvasId);
    assert.equal(entry?.name, "Sketchbook");
    assert.equal(entry?.mode, "offline");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an online canvas is published straight away and routes by room id", async () => {
  clearMockIndexedDB();
  await completeOnboarding("Tester");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";

    if (url.endsWith("/users/register")) {
      return Promise.resolve(
        new Response(JSON.stringify({ user: { id: "u1", name: "Tester" } }), {
          status: 200,
        }),
      );
    }
    if (url.endsWith("/rooms") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ rooms: [] }), { status: 200 }),
      );
    }
    if (url.endsWith("/rooms") && method === "POST") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            room: {
              id: "room-1",
              localCanvasId: "ignored",
              name: "Kickoff",
              code: "7K2M9",
              createdBy: "u1",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            created: true,
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const created = await createCanvas("online", "Kickoff");
    assert.equal(created.mode, "online");
    assert.equal(created.roomId, "room-1");

    const entry = await getCanvasEntry(created.localCanvasId);
    assert.equal(entry?.mode, "online");
    assert.equal(entry?.roomId, "room-1");
    assert.equal(entry?.roomCode, "7K2M9");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed online create leaves no stray offline canvas behind", async () => {
  clearMockIndexedDB();
  await completeOnboarding("Tester");

  const before = (await listLocalCanvases()).length;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/users/register")) {
      return Promise.resolve(
        new Response(JSON.stringify({ user: { id: "u1", name: "Tester" } }), {
          status: 200,
        }),
      );
    }
    // Both the list reconciliation and the publish itself fail, so the create
    // is unambiguously a failure rather than a recoverable one.
    return Promise.resolve(new Response("server exploded", { status: 500 }));
  };

  try {
    await assert.rejects(createCanvas("online", "Doomed"));
    const after = await listLocalCanvases();
    assert.equal(after.length, before);
    assert.equal(
      after.some((entry) => entry.name === "Doomed"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
