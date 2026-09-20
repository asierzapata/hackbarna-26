import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, createRoom, registerUser, setup, ticket, EventsClient } from "./helpers";

const graph = { type: "diagram", nodes: [{ id: "a", label: "Request", group: "workflow" }, { id: "b", label: "Approved?", geo: "diamond", group: "workflow" }, { id: "c", label: "Ship" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c", label: "Yes" }], groups: [{ id: "workflow", label: "Workflow" }] };

test("shared graph creation validates native records, binds grouped nodes and retries idempotently", async t => {
  const ctx = await setup({ classifier: null });
  t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  const ev = new EventsClient(ctx.server.port(), room.id, await ticket(user, ctx.base, room.id, "events"));
  t.after(() => ev.close());
  await ev.ready;
  ev.executorReady("diagram-fixture");
  await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "@kan draw a workflow" }) });
  const trigger = ctx.server.engine.listTriggers(room.id)[0];
  const claim = await api(user, ctx.base, `/rooms/${room.id}/triggers/${trigger.id}/claim`, { method: "POST", body: JSON.stringify({ sessionId: ev.sessionId, manual: true }) });
  assert.equal(claim.status, 200);
  const { runId, leaseToken } = claim.body.lease;
  const request = { method: "POST", headers: { authorization: `Bearer ${leaseToken}` }, body: JSON.stringify({ id: randomUUID(), operations: [graph] }) };
  const response = await api(null, ctx.base, `/rooms/${room.id}/runs/${runId}/mutate`, request);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.shapeIds.length, 6);
  const retry = await api(null, ctx.base, `/rooms/${room.id}/runs/${runId}/mutate`, request);
  assert.deepEqual(retry.body, response.body);
  const records = (await api(user, ctx.base, `/rooms/${room.id}/canvas`)).body.records;
  const frame = records.find((record: any) => record.type === "frame");
  assert.equal(frame.props.name, "Workflow");
  assert.equal(records.filter((record: any) => record.type === "geo" && record.parentId === frame.id).length, 2);
  assert.equal(records.filter((record: any) => record.typeName === "binding").length, 4);
  assert.ok(records.filter((record: any) => record.typeName === "shape").every((record: any) => record.meta.provenance.runId === runId));
  const invalid = await api(null, ctx.base, `/rooms/${room.id}/runs/${runId}/mutate`, { ...request, body: JSON.stringify({ id: randomUUID(), operations: [graph, { type: "connect", from: "shape:missing", to: "shape:missing-too" }] }) });
  assert.equal(invalid.status, 400);
  assert.equal((await api(user, ctx.base, `/rooms/${room.id}/canvas`)).body.records.length, records.length);
});
