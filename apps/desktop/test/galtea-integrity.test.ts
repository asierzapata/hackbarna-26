import assert from "node:assert/strict";
import { test } from "node:test";

const { checkMutationIntegrity } = await import("../../../scripts/galtea-integrity.mjs");
const operations = [{ type: "style", shapeId: "shape:a", color: "blue" }, { type: "label", shapeId: "shape:a", text: "Updated" }];
const result = (color = "blue", label = "Updated") => ({ proposedResult: { kind: "act", operations }, afterCanvas: [{ id: "shape:a", label, props: { color } }] });

test("Galtea integrity checks applied state rather than trusting the proposed actions", () => {
  assert.equal(checkMutationIntegrity(result()).score, 1);
  assert.equal(checkMutationIntegrity(result("red")).score, 0);
  assert.equal(checkMutationIntegrity(result("blue", "Original")).score, 0);
  assert.equal(checkMutationIntegrity({ ...result(), afterCanvas: [] }).score, 0);
});

test("Galtea integrity honors the last explicitly requested value for repeated fields", () => {
  const run = result("green");
  run.proposedResult.operations = [...operations, { type: "style", shapeId: "shape:a", color: "green" }];
  assert.equal(checkMutationIntegrity(run).score, 1);
});

test("Galtea integrity excludes replies and fails application errors", () => {
  assert.equal(checkMutationIntegrity({ proposedResult: { kind: "reply" } }).applicable, false);
  assert.equal(checkMutationIntegrity({ ...result(), applicationError: "Failed to apply" }).score, 0);
});

test("Galtea integrity compares card drafts structurally", () => {
  const draft = { type: "markdown", title: "Review", body: "Pending" };
  const run = { proposedResult: { operations: [{ type: "update", shapeId: "shape:a", draft }] }, afterCanvas: [{ id: "shape:a", props: { draft: { body: "Pending", title: "Review", type: "markdown" } } }] };
  assert.equal(checkMutationIntegrity(run).score, 1);
  run.afterCanvas[0].props.draft.body = "Old content";
  assert.equal(checkMutationIntegrity(run).score, 0);
});
