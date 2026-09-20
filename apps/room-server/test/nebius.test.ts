import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { JevClassifier } from "../src/classifier";
import { configFromEnv } from "../src/config";
import type { ClassificationState, Decision } from "../src/decision-policy";
import { NebiusClassifier, NEBIUS_CLASSIFIER_MODEL } from "../src/nebius-classifier";
import { api, createRoom, EventsClient, registerUser, setup, ticket } from "./helpers";

const state: ClassificationState = {
  cause: { id: "entry:test", kind: "message", text: "We agreed to launch on Monday.", authorId: "user:test" },
  recentEntries: [], shapes: [{ id: "shape:launch", label: "Launch plan" }], openSuggestions: [],
};
const decision: Decision = {
  addressedProbability: 0, worthCapturingProbability: 0.95, intent: "capture", intentProbability: 0.95,
  relatedShapeId: "shape:launch", needsExternalDataProbability: 0, captureScore: 3,
};
const completion = (content: unknown = decision, finishReason = "stop") => Response.json({
  choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(content) } }],
});

test("Nebius is opt-in and validates configuration without changing existing providers", () => {
  assert.equal(configFromEnv({ NEBIUS_API_KEY: "test-key" }).classifier, null);
  assert.equal(configFromEnv({ KAN_CLASSIFIER: "disabled", NEBIUS_API_KEY: "test-key" }).classifier, null);
  assert.ok(configFromEnv({ AI_GATEWAY_API_KEY: "test-key" }).classifier instanceof JevClassifier);
  assert.ok(configFromEnv({ KAN_CLASSIFIER: "nebius", NEBIUS_API_KEY: "test-key" }).classifier instanceof NebiusClassifier);
  assert.throws(() => configFromEnv({ KAN_CLASSIFIER: "nebius" }), /NEBIUS_API_KEY/);
  assert.throws(() => configFromEnv({ KAN_CLASSIFIER: "nebius", NEBIUS_API_KEY: " " }), /NEBIUS_API_KEY/);
  assert.throws(() => new NebiusClassifier("test-key", " "), /model/);
});

test("Nebius requests bounded structured output with policy separate from untrusted room data", async () => {
  let calls = 0;
  const classifier = new NebiusClassifier("test-key", undefined, async (url, init) => {
    calls++;
    assert.equal(url, "https://api.tokenfactory.nebius.com/v1/chat/completions");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    assert.ok(init?.signal instanceof AbortSignal);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, NEBIUS_CLASSIFIER_MODEL);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.temperature, 0);
    assert.equal(body.stream, false);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /untrusted/);
    assert.equal(body.messages[1].role, "user");
    assert.deepEqual(JSON.parse(body.messages[1].content), state);
    assert.ok(!String(init?.body).includes("test-key"));
    return completion();
  });
  assert.deepEqual(await classifier.decide(state), decision);
  assert.equal(calls, 1);
});

test("Nebius rejects malformed decisions, unknown shapes, refusals, and truncated output", async () => {
  const invalid = [
    { ...decision, addressedProbability: 1.1 }, { ...decision, captureScore: -1 },
    { ...decision, intent: "act" }, { ...decision, relatedShapeId: "shape:invented" },
    { ...decision, operations: [{ type: "remove" }] }, {},
  ];
  for (const value of invalid) {
    const classifier = new NebiusClassifier("test-key", undefined, async () => completion(value));
    await assert.rejects(classifier.decide(state), /invalid response/);
  }
  for (const response of [completion(decision, "length"), Response.json({ choices: [] }),
    Response.json({ choices: [{ finish_reason: "stop", message: { refusal: "private details", content: JSON.stringify(decision) } }] }),
    Response.json({ choices: [{ finish_reason: "stop", message: { content: "private malformed output" } }] }),
    new Response("private malformed body"),
  ]) {
    await assert.rejects(new NebiusClassifier("test-key", undefined, async () => response).decide(state), /invalid response/);
  }
});

test("Nebius sanitizes provider errors and never retries a billed request", async () => {
  for (const status of [401, 429, 500]) {
    let calls = 0;
    const classifier = new NebiusClassifier("test-key", undefined, async () => {
      calls++;
      return new Response("private-provider-details test-key", { status });
    });
    await assert.rejects(classifier.decide(state), { message: `Nebius classifier HTTP ${status}` });
    assert.equal(calls, 1);
  }
  await assert.rejects(new NebiusClassifier("test-key", undefined, async () => {
    throw new Error("private-network-details test-key");
  }).decide(state), { message: "Nebius classifier request failed or timed out" });
});

test("Nebius bounds context before transmission and keeps credentials out of serialization", async () => {
  let calls = 0;
  const classifier = new NebiusClassifier("private-key", "custom-model", async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init?.body)).model, "custom-model");
    return completion({ ...decision, relatedShapeId: null });
  });
  assert.ok(!JSON.stringify(classifier).includes("private-key"));
  await assert.rejects(classifier.decide({ ...state, cause: { ...state.cause, text: "x".repeat(128_001) } }), /context too large/);
  assert.equal(calls, 0);
  assert.equal((await classifier.decide({ ...state, shapes: [] })).relatedShapeId, null);
});

test("Nebius attaches the existing classifier deadline to the request", async (t) => {
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 8_000);
    return AbortSignal.abort();
  });
  const classifier = new NebiusClassifier("test-key", undefined, async (_url, init) => {
    init?.signal?.throwIfAborted();
    return completion();
  });
  await assert.rejects(classifier.decide(state), /request failed or timed out/);
});

test("Nebius decisions flow through real HTTP and WebSocket room policy without mutating the canvas", async (t) => {
  let calls = 0;
  let fail = false;
  const classifier = new NebiusClassifier("test-key", undefined, async () => {
    calls++;
    return fail ? new Response("private details", { status: 503 }) : completion({ ...decision, relatedShapeId: null });
  });
  const ctx = await setup({ classifier, video: null, timings: { debounceMs: 1 } });
  t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base);
  const room = await createRoom(user, ctx.base);
  const events = new EventsClient(ctx.server.port(), room.id, await ticket(user, ctx.base, room.id, "events"));
  t.after(() => events.close());
  await events.ready;
  const before = ctx.server.engine.canvasRecords(room.id);
  const post = async (text: string) => {
    const id = randomUUID();
    assert.equal((await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id, text }) })).status, 200);
    await ctx.server.engine.classifierIdle(room.id);
    return id;
  };
  await post(state.cause.text);
  const triggers = (await api(user, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers;
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].mode, "context");
  assert.equal(calls, 1);
  await events.waitFor(message => message.type === "event" && message.event.type === "entry.upsert" && message.event.entry?.kind === "trigger");
  assert.deepEqual(ctx.server.engine.canvasRecords(room.id), before);
  fail = true;
  const id = await post("Another synthetic update.");
  const row = ctx.server.engine.db.prepare("SELECT status,output FROM decisions WHERE entry_id=?").get(id)!;
  assert.equal(row.status, "failed");
  assert.deepEqual(JSON.parse(String(row.output)), { error: "classifier_unavailable" });
  const priorCalls = calls;
  await post("@kan draw a box");
  assert.equal(calls, priorCalls);
  assert.ok(ctx.server.engine.listTriggers(room.id).some(trigger => trigger.mode === "act"));
});
