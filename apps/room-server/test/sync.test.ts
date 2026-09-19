import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Store } from "@tldraw/store";
import { atom } from "@tldraw/state";
import * as syncCore from "@tldraw/sync-core";
import { createKanSchema } from "@kan/nodes";
import { api, createRoom, registerUser, setup, sleep, ticket, EventsClient } from "./helpers";
import { randomUUID } from "node:crypto";
import { openDb } from "../src/db";
import { createRoomServer } from "../src/server";

const { ClientWebSocketAdapter, TLSyncClient } = syncCore as any;

// ClientWebSocketAdapter / Store subscribe to browser globals for reconnect hints & scheduling
(globalThis as any).window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };
(globalThis as any).document ??= { addEventListener() {}, removeEventListener() {}, hidden: false };
(globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 16);
(globalThis as any).cancelAnimationFrame ??= (id: number) => clearTimeout(id);

async function syncClient(port: number, roomId: string, ticketStr: string) {
  const store = new Store({ schema: createKanSchema(), props: {} as never });
  const socket = new ClientWebSocketAdapter(() => `ws://127.0.0.1:${port}/sync/${roomId}?ticket=${ticketStr}`);
  const client = await new Promise<any>((resolve, reject) => {
    const c = new TLSyncClient({
      store,
      socket,
      presence: atom("presence", null),
      onLoad: () => resolve(c),
      onSyncError: (r: string) => reject(new Error(String(r))),
    });
  });
  const close = () => { client.close(); socket.close(); };
  return { client, store, socket, close };
}

async function waitForRecord(store: Store<any>, id: string, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const rec = store.get(id as never);
    if (rec) return rec;
    await sleep(30);
  }
  return undefined;
}

function textShape(id: string, text: string, meta: Record<string, unknown> = {}) {
  return {
    id,
    typeName: "shape",
    type: "text",
    x: 10,
    y: 10,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    props: {
      color: "black",
      size: "m",
      w: 100,
      font: "draw",
      textAlign: "start",
      autoSize: true,
      scale: 1,
      richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    },
    meta,
  } as any;
}

test("two genuine tldraw clients exchange document edits; restart persists; rooms isolated", async () => {
  const ctx = await setup({ classifier: null });
  const u1 = await registerUser(ctx.base, "a");
  const u2 = await registerUser(ctx.base, "b");
  const roomA = await createRoom(u1, ctx.base);
  const roomB = await createRoom(u1, ctx.base);
  await api(u2, ctx.base, "/rooms/join", { method: "POST", body: JSON.stringify({ code: roomA.code }) });

  const c1 = await syncClient(ctx.server.port(), roomA.id, await ticket(u1, ctx.base, roomA.id, "sync"));
  const c2 = await syncClient(ctx.server.port(), roomA.id, await ticket(u2, ctx.base, roomA.id, "sync"));

  c1.store.put([textShape("shape:t1", "hello canvas")]);
  const seen = await waitForRecord(c2.store, "shape:t1");
  assert.ok(seen, "second client received shape");

  c2.store.put([textShape("shape:t2", "reply")]);
  assert.ok(await waitForRecord(c1.store, "shape:t2"));

  // room isolation: a room-B client must not see room-A records
  const c3 = await syncClient(ctx.server.port(), roomB.id, await ticket(u1, ctx.base, roomB.id, "sync"));
  assert.equal(c3.store.get("shape:t1" as never), undefined);

  // persisted records are returned by the canvas endpoint
  const canvas = await api(u1, ctx.base, `/rooms/${roomA.id}/canvas`);
  const ids = canvas.body.records.map((r: any) => r.id);
  assert.ok(ids.includes("shape:t1") && ids.includes("shape:t2"));

  c1.close();
  c2.close();
  c3.close();

  // restart: a fresh server over the same db file serves the same records
  await ctx.server.close();
  const db2 = openDb(join(ctx.dir, "kan.sqlite"));
  const server2 = createRoomServer({ db: db2, classifier: null, video: null, timings: { tickMs: 0 } });
  await new Promise<void>((r) => server2.server.listen(0, "127.0.0.1", r));
  const base2 = `http://127.0.0.1:${server2.port()}`;
  const canvas2 = await api(u1, base2, `/rooms/${roomA.id}/canvas`);
  const ids2 = canvas2.body.records.map((r: any) => r.id);
  assert.ok(ids2.includes("shape:t1") && ids2.includes("shape:t2"));
  // and a sync client on the restarted server sees them
  const c4 = await syncClient(server2.port(), roomA.id, await ticket(u1, base2, roomA.id, "sync"));
  assert.ok(await waitForRecord(c4.store, "shape:t1"));
  c4.close();
  await server2.close();
  db2.close();
  await ctx.cleanup();
});

test("forged provenance on client writes is stripped server-side", async () => {
  const ctx = await setup({ classifier: null });
  const u1 = await registerUser(ctx.base);
  const room = await createRoom(u1, ctx.base);
  const c1 = await syncClient(ctx.server.port(), room.id, await ticket(u1, ctx.base, room.id, "sync"));
  c1.store.put([
    textShape("shape:forged", "sneaky", { provenance: { runId: "fake", agentId: "rootkit" } }),
  ]);
  await sleep(200);
  const canvas = await api(u1, ctx.base, `/rooms/${room.id}/canvas`);
  const rec = canvas.body.records.find((r: any) => r.id === "shape:forged");
  assert.ok(rec);
  assert.equal((rec.meta as any)?.provenance, undefined);
  c1.close();
  await ctx.cleanup();
});

test("human canvas edits produce debounced system entries attributed to the editor", async () => {
  const ctx = await setup();
  const u1 = await registerUser(ctx.base, "Ada");
  const room = await createRoom(u1, ctx.base);
  const c1 = await syncClient(ctx.server.port(), room.id, await ticket(u1, ctx.base, room.id, "sync"));
  c1.store.put([textShape("shape:e1", "first idea")]);
  await sleep(300);
  ctx.clock.advance(3000);
  ctx.server.engine.tick();
  const thread = await api(u1, ctx.base, `/rooms/${room.id}/thread`);
  const sys = thread.body.entries.find((e: any) => e.kind === "system");
  assert.ok(sys, "system entry written");
  assert.equal(sys.authorId, u1.id);
  assert.ok(sys.shapeIds.includes("shape:e1"));
  assert.match(sys.text, /Ada/);
  // classifier saw it as a system cause (no agent loop: agent writes never reach here)
  assert.ok(ctx.classifier.calls.some((s) => s.cause.kind === "system"));
  c1.close();
  await ctx.cleanup();
});

test("genuine tldraw receives server add update connect arrange; noop push cannot create feedback", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  const c1 = await syncClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "sync")); t.after(() => c1.close());
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "events")); await ev.ready; t.after(() => ev.close());
  await api(u, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@assistant add nodes" }) }); await ctx.server.engine.classifierIdle(room.id);
  ctx.server.engine.setExecutorReady(room.id, ev.sessionId, true, "test");
  const lease = ctx.server.engine.claimTrigger(u.id, room.id, ctx.server.engine.listTriggers(room.id)[0].id, { sessionId: ev.sessionId, manual: true });
  const mutate = (operations: import("@kan/protocol").Mutation[]) => ctx.server.engine.mutate(room.id, lease.runId, `Bearer ${lease.leaseToken}`, { id: randomUUID(), operations });
  const added = mutate([{ type: "add", shapeId: "shape:a", draft: { type: "concept", label: "a" } }, { type: "add", shapeId: "shape:b", draft: { type: "concept", label: "b" } }]);
  for (const id of added.shapeIds) assert.ok(await waitForRecord(c1.store, id));
  mutate([{ type: "update", shapeId: "shape:a", draft: { type: "concept", label: "changed" } }]);
  await sleep(150); assert.equal((c1.store.get("shape:a" as never) as any).props.draft.label, "changed");
  const arrow = mutate([{ type: "connect", from: "shape:a", to: "shape:b", label: "link" }]);
  assert.ok(await waitForRecord(c1.store, arrow.shapeIds[0]));
  assert.equal(c1.store.allRecords().filter((r: any) => r.typeName === "binding").length, 2);
  for (const rec of ctx.server.engine.canvasRecords(room.id) as any[]) createKanSchema().types[rec.typeName as "shape"].validator.validate(rec);
  c1.store.put([textShape("shape:human", "human")]); await sleep(150); ctx.clock.advance(3000); ctx.server.engine.tick(); await ctx.server.engine.classifierIdle(room.id);
  const count = ctx.server.engine.thread(room.id, 0, 100).entries.filter((e) => e.kind === "system").length;
  const human = c1.store.get("shape:human" as never) as ReturnType<typeof textShape>;
  const humanBefore = ctx.server.engine.canvasRecords(room.id).find((r: any) => r.id === "shape:human");
  c1.store.put([{ ...human, meta: { ...human.meta, provenance: { runId: "forged" } } } as never]); await sleep(150);
  assert.deepEqual(ctx.server.engine.canvasRecords(room.id).find((r: any) => r.id === "shape:human"), humanBefore);
  mutate([{ type: "arrange", shapeIds: ["shape:a", "shape:b"], layout: "column" }]);
  await sleep(150); ctx.clock.advance(3000); ctx.server.engine.tick();
  assert.equal((c1.store.get("shape:b" as never) as any).y, 280);
  assert.equal((c1.store.get("shape:b" as never) as any).meta.provenance.runId, lease.runId);
  assert.equal(ctx.server.engine.thread(room.id, 0, 100).entries.filter((e) => e.kind === "system").length, count, JSON.stringify(ctx.server.engine.thread(room.id, 0, 100).entries.filter((e) => e.kind === "system")));
});

test("native sync rejects forged assets and links owned uploads for room members", async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base), stranger = await registerUser(ctx.base), room = await createRoom(u, ctx.base);
  const owned = ctx.server.engine.createAsset(u.id, "image/png", Buffer.from([1]));
  const other = ctx.server.engine.createAsset(stranger.id, "image/png", Buffer.from([2]));
  const c = await syncClient(ctx.server.port(), room.id, await ticket(u, ctx.base, room.id, "sync")); t.after(() => c.close());
  const asset = (id: string, src: string): any => ({ id, typeName: "asset", type: "image", meta: {}, props: { src, w: 1, h: 1, mimeType: "image/png", isAnimated: false, name: "test", fileSize: 1 } });
  c.store.put([asset("asset:forged", `/assets/${other.id}`)]); await sleep(150);
  assert.equal(ctx.server.engine.canvasRecords(room.id).some((r: any) => r.id === "asset:forged"), false);
  c.store.put([asset("asset:owned", `/assets/${owned.id}`)]); await sleep(150);
  assert.ok(ctx.server.engine.canvasRecords(room.id).some((r: any) => r.id === "asset:owned"));
  ctx.server.engine.joinRoom(stranger.id, room.code);
  assert.equal(ctx.server.engine.getAsset(owned.id, stranger.id).data.byteLength, 1);
});
