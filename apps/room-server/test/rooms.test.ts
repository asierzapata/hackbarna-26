import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { api, createRoom, registerUser, setup } from "./helpers";

test("register is idempotent with correct secret, 409 with wrong", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const id = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const r1 = await api(null, ctx.base, "/users/register", {
    method: "POST",
    body: JSON.stringify({ userId: id, secret, name: "A" }),
  });
  assert.equal(r1.status, 200);
  const r2 = await api(null, ctx.base, "/users/register", {
    method: "POST",
    body: JSON.stringify({ userId: id, secret, name: "A" }),
  });
  assert.equal(r2.status, 200);
  const r3 = await api(null, ctx.base, "/users/register", {
    method: "POST",
    body: JSON.stringify({ userId: id, secret: randomBytes(32).toString("hex"), name: "A" }),
  });
  assert.equal(r3.status, 409);
});

test("auth required, bearer format enforced", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  assert.equal((await api(null, ctx.base, "/me")).status, 401);
  const bad = await fetch(`${ctx.base}/me`, { headers: { authorization: `Bearer ${u.id}.deadbeef` } });
  assert.equal(bad.status, 401);
  assert.equal((await api(u, ctx.base, "/me")).status, 200);
});

test("publish is idempotent per (user, localCanvasId) and never reseeds", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const localCanvasId = randomUUID();
  const body = {
    localCanvasId,
    name: "Canvas",
    messages: [{ id: randomUUID(), text: "hi", at: new Date().toISOString() }],
  };
  const r1 = await api(u, ctx.base, "/rooms", { method: "POST", body: JSON.stringify(body) });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.created, true);
  const r2 = await api(u, ctx.base, "/rooms", {
    method: "POST",
    body: JSON.stringify({ ...body, name: "changed", messages: [] }),
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.created, false);
  assert.equal(r2.body.room.id, r1.body.room.id);
  assert.equal(r2.body.room.name, "Canvas");
  // original message still there
  const thread = await api(u, ctx.base, `/rooms/${r1.body.room.id}/thread`);
  assert.equal(thread.body.entries.length, 1);
});

test("room code join with hyphens, invalid codes rejected, membership enforced", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const u1 = await registerUser(ctx.base, "one");
  const u2 = await registerUser(ctx.base, "two");
  const room = await createRoom(u1, ctx.base);
  assert.match(room.code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
  assert.notEqual(room.code, room.id);

  const hyphen = `${room.code.slice(0, 5)}-${room.code.slice(5)}`;
  const j = await api(u2, ctx.base, "/rooms/join", { method: "POST", body: JSON.stringify({ code: hyphen }) });
  assert.equal(j.status, 200);
  assert.equal(j.body.room.id, room.id);

  assert.equal(
    (await api(u2, ctx.base, "/rooms/join", { method: "POST", body: JSON.stringify({ code: "bad" }) })).status,
    400,
  );
  assert.equal(
    (
      await api(u2, ctx.base, "/rooms/join", {
        method: "POST",
        body: JSON.stringify({ code: "ZZZZZZZZZZ".replace(/Z/g, "A") }),
      })
    ).status,
    404,
  );

  // non-member denied on third room
  const u3 = await registerUser(ctx.base, "three");
  assert.equal((await api(u3, ctx.base, `/rooms/${room.id}`)).status, 403);
  assert.equal((await api(u3, ctx.base, `/rooms/${randomUUID()}`)).status, 404);

  // members listing works
  const detail = await api(u1, ctx.base, `/rooms/${room.id}`);
  assert.equal(detail.body.members.length, 2);

  // rename writes a system event
  const r = await api(u2, ctx.base, `/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ name: "New" }) });
  assert.equal(r.status, 200);
  const thread = await api(u1, ctx.base, `/rooms/${room.id}/thread`);
  assert.ok(thread.body.entries.some((e: any) => e.kind === "system" && e.text.includes("New")));

  // open updates recent access; list includes lastOpenedAt
  assert.equal((await api(u2, ctx.base, `/rooms/${room.id}/open`, { method: "POST" })).status, 200);
  const rooms = await api(u2, ctx.base, "/rooms");
  assert.equal(rooms.body.rooms[0].id, room.id);
  assert.ok(rooms.body.rooms[0].lastOpenedAt);
});

test("invalid snapshot leaves nothing behind (all-or-nothing)", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const u = await registerUser(ctx.base);
  const localCanvasId = randomUUID();
  const bad = await api(u, ctx.base, "/rooms", {
    method: "POST",
    body: JSON.stringify({
      localCanvasId,
      name: "x",
      records: [{ id: "session:abc", typeName: "session" }],
    }),
  });
  assert.equal(bad.status, 400);
  const rooms = await api(u, ctx.base, "/rooms");
  assert.equal(rooms.body.rooms.length, 0);
  // retry with valid records works
  const good = await api(u, ctx.base, "/rooms", { method: "POST", body: JSON.stringify({ localCanvasId, name: "x" }) });
  assert.equal(good.status, 200);

  // forged asset src rejected atomically
  const forged = await api(u, ctx.base, "/rooms", {
    method: "POST",
    body: JSON.stringify({
      localCanvasId: randomUUID(),
      name: "y",
      records: [
        {
          id: "asset:a1",
          typeName: "asset",
          type: "image",
          meta: {},
          props: { src: "https://evil.example/x.png", w: 1, h: 1, mimeType: "image/png", isAnimated: false, name: "x" },
        },
      ],
    }),
  });
  assert.equal(forged.status, 400);
  // blob: source rejected too
  const blob = await api(u, ctx.base, "/rooms", {
    method: "POST",
    body: JSON.stringify({
      localCanvasId: randomUUID(),
      name: "y",
      records: [
        {
          id: "asset:a1",
          typeName: "asset",
          type: "image",
          meta: {},
          props: { src: "blob:http://x/1", w: 1, h: 1, mimeType: "image/png", isAnimated: false, name: "x" },
        },
      ],
    }),
  });
  assert.equal(blob.status, 400);
});

test("assets: upload, owner read, member read via linked room, stranger denied, type/size limits", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const u1 = await registerUser(ctx.base);
  const u2 = await registerUser(ctx.base);
  const up = await fetch(`${ctx.base}/assets`, {
    method: "POST",
    headers: { authorization: u1.auth, connection: "close", "content-type": "image/png" },
    body: Buffer.from([1, 2, 3]),
  });
  assert.equal(up.status, 200);
  const { id } = (await up.json()) as { id: string };

  // bad content type
  assert.equal(
    (
      await fetch(`${ctx.base}/assets`, {
        method: "POST",
        headers: { authorization: u1.auth, connection: "close", "content-type": "text/html" },
        body: "<script>",
      })
    ).status,
    400,
  );

  // stranger denied while unlinked
  const denied = await fetch(`${ctx.base}/assets/${id}`, { headers: { authorization: u2.auth, connection: "close" } });
  assert.equal(denied.status, 403);
  const own = await fetch(`${ctx.base}/assets/${id}`, { headers: { authorization: u1.auth, connection: "close" } });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("x-content-type-options"), "nosniff");

  // link to room via publish; member can now read
  await createRoom(u1, ctx.base, { assetIds: [id] });
  const rooms = (await api(u1, ctx.base, "/rooms")).body.rooms;
  const room = rooms[0];
  await api(u2, ctx.base, "/rooms/join", { method: "POST", body: JSON.stringify({ code: room.code }) });
  const memberRead = await fetch(`${ctx.base}/assets/${id}`, { headers: { authorization: u2.auth, connection: "close" } });
  assert.equal(memberRead.status, 200);
  assert.equal((await memberRead.arrayBuffer()).byteLength, 3);

  // oversize rejected
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${ctx.base}/assets`, { method: "POST", headers: { authorization: u1.auth, "content-type": "application/octet-stream", "content-length": String(11 * 1024 * 1024) } }, (res) => { resolve(res.statusCode!); res.resume(); req.destroy(); });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("asset limit response timed out")); });
    req.flushHeaders();
  });
  assert.equal(status, 413);
});

test("leaving a room removes only the leaver's membership", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const owner = await registerUser(ctx.base, "Owner");
  const guest = await registerUser(ctx.base, "Guest");
  const room = await createRoom(owner, ctx.base);
  await api(guest, ctx.base, "/rooms/join", {
    method: "POST",
    body: JSON.stringify({ code: room.code }),
  });

  const left = await api(guest, ctx.base, `/rooms/${room.id}/leave`, { method: "POST" });
  assert.equal(left.status, 200);

  assert.deepEqual(
    (await api(guest, ctx.base, "/rooms")).body.rooms.map((r: any) => r.id),
    [],
  );
  assert.deepEqual(
    (await api(owner, ctx.base, "/rooms")).body.rooms.map((r: any) => r.id),
    [room.id],
  );
  // The room itself is untouched, and the leaver is now an outsider to it.
  assert.equal((await api(owner, ctx.base, `/rooms/${room.id}`)).status, 200);
  assert.equal((await api(guest, ctx.base, `/rooms/${room.id}`)).status, 403);
  assert.equal((await api(guest, ctx.base, `/rooms/${room.id}/leave`, { method: "POST" })).status, 403);

  const thread = await api(owner, ctx.base, `/rooms/${room.id}/thread`);
  assert.ok(
    thread.body.entries.some((e: any) => e.kind === "system" && e.text === "Guest left the room"),
    JSON.stringify(thread.body.entries),
  );
});

test("rejoining by code after leaving restores membership and the canvas", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const owner = await registerUser(ctx.base, "Owner");
  const room = await createRoom(owner, ctx.base, {
    messages: [{ id: randomUUID(), text: "before", at: new Date().toISOString() }],
  });

  assert.equal((await api(owner, ctx.base, `/rooms/${room.id}/leave`, { method: "POST" })).status, 200);
  assert.deepEqual((await api(owner, ctx.base, "/rooms")).body.rooms, []);

  const rejoin = await api(owner, ctx.base, "/rooms/join", {
    method: "POST",
    body: JSON.stringify({ code: room.code }),
  });
  assert.equal(rejoin.status, 200);
  assert.equal(rejoin.body.room.id, room.id);
  const thread = await api(owner, ctx.base, `/rooms/${room.id}/thread`);
  assert.ok(thread.body.entries.some((e: any) => e.text === "before"));
});

test("leaving a room the caller is not in or that does not exist is rejected", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.cleanup());
  const owner = await registerUser(ctx.base, "Owner");
  const outsider = await registerUser(ctx.base, "Outsider");
  const room = await createRoom(owner, ctx.base);

  assert.equal((await api(outsider, ctx.base, `/rooms/${room.id}/leave`, { method: "POST" })).status, 403);
  assert.equal((await api(owner, ctx.base, `/rooms/${randomUUID()}/leave`, { method: "POST" })).status, 404);
  assert.equal((await api(null, ctx.base, `/rooms/${room.id}/leave`, { method: "POST" })).status, 401);
  assert.equal((await api(owner, ctx.base, "/rooms")).body.rooms.length, 1);
});
