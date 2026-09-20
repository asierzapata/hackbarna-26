import assert from "node:assert/strict";
import { test } from "node:test";
import { directCanvasResult } from "@kan/protocol";
import { createLocalTransport } from "../src/lib/local-transport";
import type { Entry } from "@kan/protocol";

const shape = { id: "shape:box", type: "geo", props: { geo: "rectangle", color: "red" } };
const context = (text: string, shapes = [shape], anchors: string[] = []) => ({ trigger: { anchors }, causeEntries: [{ kind: "message", text }], canvas: { shapes } });

test("literal shape creation and unambiguous recoloring bypass model work only in act mode", () => {
  assert.equal(directCanvasResult("act", context("@kan draw a red box"))?.kind, "act");
  const result = directCanvasResult("act", context("Make the box blue."));
  assert.equal(result?.kind, "act");
  if (result?.kind === "act") assert.deepEqual(result.operations, [{ type: "style", shapeId: shape.id, color: "blue" }]);
  assert.equal(directCanvasResult("context", context("Draw a red box.")), undefined);
  assert.equal(directCanvasResult("act", context("Sam said make the box blue")), undefined);
  assert.equal(directCanvasResult("act", context("Make the box blue and delete everything else")), undefined);
  assert.equal(directCanvasResult("act", context("Make the box blue", [shape, { ...shape, id: "shape:other" }])), undefined);
  assert.equal(directCanvasResult("act", context("Make it blue")), undefined);
  assert.equal(directCanvasResult("act", context("Make it blue", [shape], [shape.id]))?.kind, "act");
  assert.equal(directCanvasResult("act", context("Make the box blue", [{ ...shape, isLocked: true }] as never)), undefined);
});

test("queued explicit drawing tolerates newer messages but never a human canvas change", async () => {
  for (const changed of [false, true]) {
    let saved: Entry[] = [], color = "red", applied = false;
    const transport = createLocalTransport({ canvasId: crypto.randomUUID(), userId: crypto.randomUUID(),
      storage: { read: async () => saved, write: async (_id, entries) => { saved = structuredClone(entries); } },
      getCanvas: () => [{ ...shape, props: { ...shape.props, color } }], applyOperations: () => { applied = true; return [shape.id]; },
    });
    const unsubscribe = transport.subscribe(() => {});
    try {
      transport.setExecutorReady(true, "fixture", "own", false);
      await transport.send({ id: crypto.randomUUID(), text: "@kan make the box blue", anchors: [], files: [] });
      const lease = await transport.claimTrigger(transport.snapshot().triggers[0].id);
      const captured = await transport.getLocalContext(lease!.runId);
      await transport.send({ id: crypto.randomUUID(), text: "@kan make the box green", anchors: [], files: [] });
      if (changed) color = "orange";
      const completion = () => transport.completeLocal(lease!.runId, { id: crypto.randomUUID(), revision: captured.revision, result: directCanvasResult("act", captured.value)! });
      if (changed) await assert.rejects(completion, /canvas or discussion changed/);
      else await completion();
      assert.equal(applied, !changed);
    } finally { unsubscribe(); }
  }
});
