import { test } from "node:test";
import assert from "node:assert/strict";
import { triggerDecision, type Decision } from "../src/decision-policy";
import { queryDemoData } from "../src/demo-data";
import { mapEvaluationAnswers } from "../src/classifier";
import { NodeDraftSchema, checkChartSpec } from "@kan/protocol";

function decision(partial: Partial<Decision>): Decision {
  return {
    addressedProbability: 0,
    worthCapturingProbability: 0,
    intent: "none",
    intentProbability: 0.5,
    relatedShapeId: null,
    needsExternalDataProbability: 0,
    captureScore: 0,
    ...partial,
  };
}

test("addressed exactly 0.8 does not act, 0.8001 does", () => {
  assert.equal(triggerDecision(decision({ addressedProbability: 0.8, intent: "answer" })), null);
  const t = triggerDecision(decision({ addressedProbability: 0.8001, intent: "answer" }));
  assert.equal(t?.mode, "act");
});

test("worthCapturing exactly 0.7 does not propose, 0.7001 does when captureScore >= 2", () => {
  assert.equal(
    triggerDecision(decision({ worthCapturingProbability: 0.7, captureScore: 3, intent: "capture" })),
    null,
  );
  const t = triggerDecision(decision({ worthCapturingProbability: 0.7001, captureScore: 2, intent: "capture" }));
  assert.equal(t?.mode, "propose");
});

test("captureScore 1.99 blocks propose, 2 allows", () => {
  assert.equal(
    triggerDecision(decision({ worthCapturingProbability: 0.9, captureScore: 1.99, intent: "capture" })),
    null,
  );
  assert.equal(
    triggerDecision(decision({ worthCapturingProbability: 0.9, captureScore: 2, intent: "capture" }))?.mode,
    "propose",
  );
});

test("intent none always produces no trigger", () => {
  assert.equal(
    triggerDecision(decision({ addressedProbability: 1, worthCapturingProbability: 1, captureScore: 4 })),
    null,
  );
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

test("mapEvaluationAnswers validates bounds and maps fields", () => {
  const state = { cause: { id: "e", kind: "message" as const, text: "", authorId: "u" }, recentEntries: [], shapes: [{ id: "shape:a", label: "L" }], openSuggestions: [] };
  const answers = {
    addressed: { probability: 0.9 },
    worthCapturing: { probability: 0.2 },
    intent: { choice: "update", probabilities: { update: 0.7 } },
    relatedShape: { choice: "shape_0", probabilities: { shape_0: 1 } },
    needsExternalData: { probability: 0.1 },
    captureWish: { score: 3 },
  };
  const d = mapEvaluationAnswers(answers, state);
  assert.equal(d.intent, "update");
  assert.equal(d.relatedShapeId, "shape:a");
  assert.equal(d.captureScore, 3);

  assert.throws(() =>
    mapEvaluationAnswers({ ...answers, addressed: { probability: 1.5 } }, state),
  );
  assert.throws(() =>
    mapEvaluationAnswers({ ...answers, intent: { choice: "bogus", probabilities: { bogus: 1 } } }, state),
  );
  assert.throws(() =>
    mapEvaluationAnswers({ ...answers, captureWish: { score: 9 } }, state),
  );
  const none = mapEvaluationAnswers({ ...answers, relatedShape: { choice: "none", probabilities: { none: 1 } } }, state);
  assert.equal(none.relatedShapeId, null);
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
