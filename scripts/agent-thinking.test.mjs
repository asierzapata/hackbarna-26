import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasThinkingTargets } from "../apps/desktop/src/lib/agent-thinking.ts";

test("focuses only the nodes addressed by canvas operations", () => {
  assert.deepEqual(canvasThinkingTargets("updateNode", { shapeId: "shape:a" }), ["shape:a"]);
  assert.deepEqual(canvasThinkingTargets("connectNodes", { from: "shape:a", to: "shape:b" }), ["shape:a", "shape:b"]);
  assert.deepEqual(canvasThinkingTargets("arrange", { shapeIds: ["shape:a", "shape:b", "shape:a"] }), ["shape:a", "shape:b"]);
  assert.deepEqual(canvasThinkingTargets("getCanvas", { shapeIds: ["shape:b"] }), ["shape:b"]);
});

test("new nodes replace the placement reference and removed nodes clear focus", () => {
  assert.deepEqual(canvasThinkingTargets("addNode", { near: { shapeId: "shape:a" } }), ["shape:a"]);
  assert.deepEqual(canvasThinkingTargets("addNode", {}, { shapeId: "shape:new" }), ["shape:new"]);
  assert.deepEqual(canvasThinkingTargets("removeNodes", { shapeIds: ["shape:a"] }), []);
});

test("broad canvas reads do not claim the whole board is being considered", () => {
  assert.equal(canvasThinkingTargets("getCanvas", { scope: "full" }, { shapes: [{ id: "shape:a" }] }), null);
  assert.equal(canvasThinkingTargets("unknown", { shapeId: "shape:a" }), null);
  assert.equal(canvasThinkingTargets("updateNode", null), null);
  assert.equal(canvasThinkingTargets("updateNode", { shapeId: 42 }), null);
  assert.deepEqual(canvasThinkingTargets("arrange", { shapeIds: ["shape:a", null, 42] }), ["shape:a"]);
});
