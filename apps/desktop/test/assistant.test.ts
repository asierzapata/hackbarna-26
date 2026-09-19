import { test } from "node:test";
import assert from "node:assert/strict";
import { extractStructuredJson, parseAssistantResult, parseStructuredOutput, runAssistantTurn } from "../src/lib/assistant-controller";

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

test("structured output survives fences and prose around the object", () => {
  const object = '{"kind":"reply","text":"Two days","sources":[]}';
  assert.deepEqual(parseStructuredOutput(object), { kind: "reply", text: "Two days", sources: [] });
  assert.deepEqual(parseStructuredOutput("```json\n" + object + "\n```"), { kind: "reply", text: "Two days", sources: [] });
  assert.deepEqual(parseStructuredOutput("Sure! Here you go:\n" + object + "\nLet me know."), { kind: "reply", text: "Two days", sources: [] });
});

test("structured output keeps braces inside strings and rejects prose-only turns", () => {
  assert.deepEqual(extractStructuredJson('{"kind":"reply","text":"a } brace \\" and more","sources":[]}'), {
    kind: "reply",
    text: 'a } brace " and more',
    sources: [],
  });
  assert.deepEqual(extractStructuredJson('{"a":{"b":1}} trailing {"c":2}'), { a: { b: 1 } });
  assert.throws(() => parseStructuredOutput("I could not do that."), /no JSON object/);
  assert.throws(() => parseStructuredOutput('{"kind":"nonsense"}'));
});
