import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { configFromEnv } from "../src/config";
import { NebiusClassifier } from "../src/nebius-classifier";
import type { Decision } from "../src/decision-policy";
import { api, createRoom, EventsClient, registerUser, setup, ticket } from "./helpers";
import { makeEvaluationRow, scenarios, type EvaluationRow } from "./nebius-evaluation";
import { DataLabError, publishEvaluation } from "./nebius-datalab";

async function main() {
  const args = process.argv.slice(2);
  if (!["", "--live", "--live --publish", "--publish --live", "--publish-existing"].includes(args.join(" "))) throw new DataLabError("Usage: nebius-live.ts [--live [--publish] | --publish-existing]");
  if (!args.length) {
    console.log(JSON.stringify({ mode: "dry-run", requests: 0, liveRequestLimit: scenarios.length, maxOutputTokensPerRequest: 512, scenarios: scenarios.map(({ id, shouldTrigger }) => ({ id, shouldTrigger })), next: "--live runs six synthetic inferences (consumes credits); --live --publish also publishes results to Data Lab; --publish-existing publishes the recorded root JSONL without inference. Publishing stores synthetic data in Nebius. Requires NEBIUS_API_KEY." }, null, 2));
    return;
  }
  if (args.includes("--publish-existing")) {
    const text = readFileSync(new URL("../../../nebius-classifier-evaluation.jsonl", import.meta.url), "utf8");
    if (Buffer.byteLength(text) > 128_000) throw new DataLabError("Recorded evaluation is too large");
    const rows = text.trim().split(/\r?\n/).map(line => JSON.parse(line));
    console.log(JSON.stringify(await publishEvaluation(process.env.NEBIUS_API_KEY ?? "", rows)));
    return;
  }
  const config = configFromEnv({ KAN_CLASSIFIER: "nebius", NEBIUS_API_KEY: process.env.NEBIUS_API_KEY, NEBIUS_CLASSIFIER_MODEL: process.env.NEBIUS_CLASSIFIER_MODEL });
  assert.ok(config.classifier instanceof NebiusClassifier);
  const provider = config.classifier;
  let requests = 0;
  let providerMs = 0;
  let lastDecision: Decision | null = null;
  const ctx = await setup({ video: null, timings: { debounceMs: 1 }, classifier: {
    async decide(state) {
      if (++requests > scenarios.length) throw new Error("Live request limit reached");
      const started = performance.now();
      try { return lastDecision = await provider.decide(state); }
      finally { providerMs = Math.round(performance.now() - started); }
    },
  } });
  const clients: EventsClient[] = [];
  const results: EvaluationRow[] = [];
  console.log(JSON.stringify({ event: "server-ready", provider: "nebius", model: provider.model, syntheticOnly: true, maxRequests: scenarios.length }));
  try {
    const user = await registerUser(ctx.base, "Synthetic evaluation participant");
    for (const scenario of scenarios) {
      const room = await createRoom(user, ctx.base, { messages: (scenario.history ?? []).map(text => ({ id: randomUUID(), text, at: new Date().toISOString(), source: "typed" })) });
      const events = new EventsClient(ctx.server.port(), room.id, await ticket(user, ctx.base, room.id, "events"));
      clients.push(events);
      await events.ready;
      const before = ctx.server.engine.canvasRecords(room.id);
      const id = randomUUID();
      lastDecision = null;
      const countBefore = requests;
      const response = await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id, text: scenario.text }) });
      assert.equal(response.status, 200);
      await ctx.server.engine.classifierIdle(room.id);
      assert.equal(requests, countBefore + 1, "Expected exactly one inference per scenario");
      const row = ctx.server.engine.db.prepare("SELECT status FROM decisions WHERE entry_id=?").get(id)!;
      assert.equal(row.status, "evaluated", "Nebius classification failed; stopping without retries or further billed requests");
      const triggers = (await api(user, ctx.base, `/rooms/${room.id}/triggers`)).body.triggers as Array<{ mode: string }>;
      assert.ok(triggers.every(trigger => trigger.mode === "context"), "Classifier cannot authorize mutations");
      const actualTrigger = triggers.length > 0;
      if (actualTrigger) await events.waitFor(message => message.type === "event" && message.event.type === "entry.upsert" && message.event.entry?.kind === "trigger");
      assert.deepEqual(ctx.server.engine.canvasRecords(room.id), before, "Classification must not modify canvas records");
      const result = { id: scenario.id, passed: actualTrigger === scenario.shouldTrigger, expectedTrigger: scenario.shouldTrigger, actualTrigger, providerMs, decision: lastDecision };
      assert.ok(lastDecision);
      results.push(makeEvaluationRow(scenario, lastDecision, actualTrigger, providerMs, provider.model));
      console.log(JSON.stringify({ event: "scenario", ...result }));
      events.close();
    }
    const passed = results.filter(result => result.passed).length;
    console.log(JSON.stringify({ event: "summary", provider: "nebius", model: provider.model, requests, passed, total: results.length, meanProviderMs: Math.round(results.reduce((sum, result) => sum + result.provider_ms, 0) / results.length), coverage: "live Nebius + room HTTP/WebSocket policy; no native UI or downstream agent execution" }));
    if (passed !== results.length) process.exitCode = 1;
    if (args.includes("--publish")) console.log(JSON.stringify(await publishEvaluation(process.env.NEBIUS_API_KEY ?? "", results)));
  } finally {
    clients.forEach(client => client.close());
    await ctx.cleanup();
  }
}

main().catch(error => {
  console.error(error instanceof DataLabError ? error.message : "Nebius evaluation or publishing failed; no write retry was attempted. Check the focused tests, account access, credits, model availability, and provider status. No response bodies or credentials are logged.");
  process.exitCode = 1;
});
