import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, createRoom, registerUser, setup } from "./helpers";

async function post(ctx: any, user: any, roomId: string, text: string, extra: Record<string, unknown> = {}) {
  return api(user, ctx.base, `/rooms/${roomId}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text, ...extra }) });
}

test("only a start-of-message invocation creates an explicit act trigger", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base);
  const room = await createRoom(user, ctx.base);
  for (const text of ["plain chat", "a midline @kan request", "email kan@example.com", "> @kan quoted", "`@kan code`", "```@kan block```"])
    assert.equal((await post(ctx, user, room.id, text)).status, 200);
  assert.equal((await post(ctx, user, room.id, "@assistant do this")).status, 200);
  const triggers = (await api(user, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].mode, "act");
  assert.equal(triggers[0].source, "explicit");
});

test("transcript hey kan invokes while imported history remains inert", async (t) => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base);
  const room = await createRoom(user, ctx.base, { messages: [{ id: randomUUID(), text: "@kan imported", at: new Date().toISOString(), source: "transcript" }] });
  assert.equal((await api(user, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers.length, 0);
  await post(ctx, user, room.id, "hey kan, answer this", { source: "transcript" });
  const triggers = (await api(user, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].mode, "act");
});
