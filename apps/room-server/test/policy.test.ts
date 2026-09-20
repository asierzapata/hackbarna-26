import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluationQuestions, triggerDecision, type Decision } from "../src/decision-policy";
import { queryDemoData } from "../src/demo-data";
import { mapEvaluationAnswers } from "../src/classifier";
import { NodeDraftSchema, checkChartSpec } from "@kan/protocol";

function decision(triggerProbability: number): Decision {
  return { triggerProbability };
}

test("binary probability must be strictly greater than 0.5", () => {
  assert.equal(triggerDecision(decision(0)), null);
  assert.equal(triggerDecision(decision(0.5)), null);
  assert.equal(triggerDecision(decision(0.5001))?.mode, "context");
});

test("a positive binary gate schedules a check without granting edit permission", () => {
  const trigger = triggerDecision(decision(1));
  assert.equal(trigger?.mode, "context");
  assert.equal(trigger?.confidence, 1);
  assert.equal(trigger?.intent, "answer");
  assert.match(trigger?.reason ?? "", /no canvas changes/i);
});

test("invalid gate probabilities cannot create triggers", () => {
  for (const value of [NaN, Infinity, -Infinity, -0.1, 1.1]) assert.equal(triggerDecision(decision(value)), null);
});

test("Jev receives one binary question with identity, addressee, and consent boundaries", () => {
  const questions = evaluationQuestions();
  assert.deepEqual(Object.keys(questions), ["shouldTrigger"]);
  assert.equal(questions.shouldTrigger.type, "boolean");
  assert.match(questions.shouldTrigger.instructions, /Kan is the AI canvas assistant/);
  assert.match(questions.shouldTrigger.instructions, /named human/);
  assert.match(questions.shouldTrigger.instructions, /does not authorize canvas edits/);
});

test("demo data: filtered 2026-09-17..18 latency rows are 155/150", () => {
  const out = queryDemoData({ source: "demo-metrics", metric: "latencyMs", from: "2026-09-17", to: "2026-09-18" });
  assert.deepEqual(out.rows, [
    { date: "2026-09-17", latencyMs: 155 },
    { date: "2026-09-18", latencyMs: 150 },
  ]);
});

test("demo data: errorRate stays a fraction", () => {
  const out = queryDemoData({ source: "demo-metrics", metric: "errorRate" });
  assert.ok(out.rows.every((r) => (r as unknown as { errorRate: number }).errorRate < 1));
});

test("demo data: empty window returns no fabricated rows", () => {
  const out = queryDemoData({ source: "demo-metrics", metric: "throughput", from: "2030-01-01", to: "2030-01-02" });
  assert.deepEqual(out.rows, []);
});

test("mapEvaluationAnswers preserves the binary probability and validates its bounds", () => {
  for (const probability of [0, 0.5, 0.91, 1]) {
    assert.deepEqual(mapEvaluationAnswers({ shouldTrigger: { probability } }), { triggerProbability: probability });
  }
  for (const probability of [NaN, Infinity, -0.1, 1.1, "0.9", null, undefined]) {
    assert.throws(() => mapEvaluationAnswers({ shouldTrigger: { probability } }));
  }
});

test("chart spec rejects url/href/expr/calculate and string filters recursively", () => {
  assert.equal(checkChartSpec({ mark: "bar", data: { values: [{ a: 1 }] } }), true);
  assert.equal(checkChartSpec({ data: { url: "https://x" } }), false);
  assert.equal(checkChartSpec({ transform: [{ filter: "datum.a > 1" }] }), false);
  assert.equal(checkChartSpec({ nested: { deep: { href: "x" } } }), false);
  assert.equal(checkChartSpec({ calculate: "datum.a" }), false);
  assert.equal(checkChartSpec({ expr: "x" }), false);
  assert.ok(!NodeDraftSchema.safeParse({ type: "chart", title: "t", spec: { data: { url: "http://evil" } }, data: [] }).success);
  assert.ok(NodeDraftSchema.safeParse({ type: "chart", title: "t", spec: { mark: "line", data: { values: [] } }, data: [{ a: 1 }] }).success);
});
