import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAssistantResult, runAssistantTurn } from "../src/lib/assistant-controller";

test("structured result parser accepts silence and rejects unknown fields", () => {
  assert.deepEqual(parseAssistantResult({ kind: "silent" }), { kind: "silent" });
  assert.throws(() => parseAssistantResult({ kind: "silent", text: "not allowed" }));
});

test("context executor cannot return an act plan and abort ignores late output", async () => {
  const abort = new AbortController();
  const executor = {
    ready: true,
    agentId: "fake",
    run: async (_mode: "context", _context: unknown, signal: AbortSignal) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(signal, abort.signal);
      return { kind: "act", text: "bad", sources: [], operations: [{ type: "arrange", shapeIds: ["shape:a"], layout: "row" }] } as never;
    },
  };
  const pending = runAssistantTurn(executor, "context", {}, abort.signal);
  abort.abort();
  await assert.rejects(() => pending, /cancelled|contextual assistant turns cannot act/);
});
