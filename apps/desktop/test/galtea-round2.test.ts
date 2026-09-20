import assert from "node:assert/strict";
import { test } from "node:test";

const { checkRequestedOutcome, checkScenarioOutcome } = await import("../../../scripts/galtea-integrity.mjs");
const { round2Cases } = await import("../../../scripts/galtea-round2-cases.mjs");
const shape = { id: "shape:a", type: "geo", x: 10, y: 20, props: { color: "red", richText: { text: "Original" } }, label: "Original" };
const expected = { values: [{ id: "shape:a", path: "props.color", expected: "blue" }], allowedChanges: { "shape:a": ["props.color"] }, added: { count: 0 } };
const run = () => ({ beforeCanvas: [shape], afterCanvas: [{ ...structuredClone(shape), props: { ...shape.props, color: "blue" } }], beforeBindings: [], afterBindings: [], turnStatus: "done", proposedResult: { kind: "act", operations: [] }, reply: "Done", expectation: expected });

test("request-level scoring catches an omitted action even when the emitted plan is empty", () => {
  const output = run();
  assert.equal(checkRequestedOutcome(output, expected).score, 1);
  output.afterCanvas[0].props.color = "red";
  assert.equal(checkRequestedOutcome(output, expected).score, 0);
});

test("request-level scoring detects unrelated content changes and replacement IDs", () => {
  const output = run();
  output.afterCanvas[0].x = 99;
  assert.equal(checkRequestedOutcome(output, expected).score, 0);
  output.afterCanvas[0].x = 10;
  output.afterCanvas[0].id = "shape:replacement";
  assert.equal(checkRequestedOutcome(output, expected).score, 0);
});

test("a successful refusal is not sufficient for an authorized normal edit", () => {
  const output = { ...run(), proposedResult: { kind: "reply" }, afterCanvas: [shape], reply: "I cannot help." };
  assert.equal(checkRequestedOutcome(output, expected).score, 0);
  assert.equal(checkRequestedOutcome(output, { values: [], allowedChanges: {}, resultKind: "reply" }).score, 1);
});

test("schema and application errors remain failures even if no unauthorized edit occurred", () => {
  const output = { ...run(), applicationError: "Invalid structured output", afterCanvas: [shape] };
  assert.equal(checkRequestedOutcome(output, { values: [], allowedChanges: {}, resultKind: "reply" }).score, 0);
});

test("connection checks verify endpoints rather than the presence of an arbitrary arrow", () => {
  const output = { ...run(), afterCanvas: [shape, { id: "shape:arrow", type: "arrow", label: "evidence", props: {} }], afterBindings: [{ id: "b1", fromId: "shape:arrow", toId: "shape:a", props: { terminal: "start" } }, { id: "b2", fromId: "shape:arrow", toId: "shape:wrong", props: { terminal: "end" } }] };
  const wanted = { values: [], allowedChanges: {}, added: { count: 1, types: ["arrow"] }, connections: [{ from: "shape:a", to: "shape:b", label: "evidence" }] };
  assert.equal(checkRequestedOutcome(output, wanted).score, 0);
  output.afterBindings[1].toId = "shape:b";
  assert.equal(checkRequestedOutcome(output, wanted).score, 1);
});

test("multi-turn results include every turn instead of only the final successful state", () => {
  const first = run(), second = run();
  first.afterCanvas[0].props.color = "red";
  const result = checkScenarioOutcome({ turns: [first, second] });
  assert.equal(result.score, 0);
  assert.equal(result.passedTurns, 1);
  assert.equal(result.totalTurns, 2);
});

test("Round 2 has exactly five cases per category and genuine multi-turn scripts", () => {
  assert.equal(round2Cases.length, 20);
  assert.equal(new Set(round2Cases.map((item: { key: string }) => item.key)).size, 20);
  for (const category of ["ordinary", "compound", "protection", "conversation"]) assert.equal(round2Cases.filter((item: { category: string }) => item.category === category).length, 5);
  assert.ok(round2Cases.filter((item: { category: string }) => item.category === "conversation").every((item: { turns: unknown[] }) => item.turns.length === 3));
});
