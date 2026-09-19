import { test } from "node:test";
import assert from "node:assert/strict";
import { extractStructuredJson, parseAssistantResult, parseStructuredOutput, runAssistantTurn, startLeaseExecution, type LeaseFailure } from "../src/lib/assistant-controller";

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

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A lease execution wired to fail wherever the caller asks it to. */
function failingExecution(breaks: "context" | "agent" | "complete", error: unknown) {
  const failures: { status: string; failure: LeaseFailure }[] = [];
  const reject = (stage: string) => (stage === breaks ? Promise.reject(error) : undefined);
  const execution = startLeaseExecution({
    triggerId: "trigger", attempt: 0, runId: "run", leaseToken: "token", expiresAt: Date.now() + 60_000, mode: "act",
    getContext: async () => (await reject("context")) ?? { revision: "rev", value: {} },
    run: async () => (await reject("agent")) ?? ({ kind: "reply", text: "hi", sources: [] } as never),
    complete: async () => reject("complete"),
    heartbeat: async () => ({ expiresAt: Date.now() + 60_000 }),
    fail: async (status, failure) => { failures.push({ status, failure }); },
  });
  return { execution, failures };
}

test("a failed run reports which phase broke and the error that broke it", async () => {
  for (const phase of ["context", "agent", "complete"] as const) {
    const { execution, failures } = failingExecution(phase, new Error(`Failed to complete run (409): conflict: run context is stale`));
    await execution.promise;
    assert.equal(failures.length, 1);
    assert.equal(failures[0].status, "failed");
    assert.equal(failures[0].failure.phase, phase);
    assert.match(describe(failures[0].failure.error), /run context is stale/);
  }
});

test("a cancelled turn stays cancelled, but a lost heartbeat is a failure that says so", async () => {
  const abortFailures: { status: string; failure: LeaseFailure }[] = [];
  const cancelled = startLeaseExecution({
    triggerId: "trigger", attempt: 0, runId: "run", leaseToken: "token", expiresAt: Date.now() + 60_000, mode: "act",
    getContext: async () => ({ revision: "rev", value: {} }),
    run: (_mode, _context, signal) => new Promise((_resolve, rejectRun) => signal.addEventListener("abort", () => rejectRun(new DOMException("assistant turn cancelled", "AbortError")))),
    complete: async () => undefined,
    heartbeat: async () => ({ expiresAt: Date.now() + 60_000 }),
    fail: async (status, failure) => { abortFailures.push({ status, failure }); },
  });
  cancelled.controller.abort();
  await cancelled.promise;
  assert.equal(abortFailures[0]?.status, "cancelled");

  // A dead lease aborts the turn the same way the stop button does, so without
  // the phase it would be reported as the user changing their mind.
  const lost: { status: string; failure: LeaseFailure }[] = [];
  const expired = startLeaseExecution({
    triggerId: "trigger", attempt: 0, runId: "run", leaseToken: "token", expiresAt: Date.now() + 60_000, mode: "act",
    heartbeatMs: 1,
    getContext: async () => ({ revision: "rev", value: {} }),
    run: (_mode, _context, signal) => new Promise((_resolve, rejectRun) => signal.addEventListener("abort", () => rejectRun(new DOMException("assistant turn cancelled", "AbortError")))),
    complete: async () => undefined,
    heartbeat: async () => { throw new Error("Run lease expired (403): forbidden: lease is stale or expired"); },
    fail: async (status, failure) => { lost.push({ status, failure }); },
  });
  await expired.promise;
  assert.equal(lost[0]?.status, "failed");
  assert.equal(lost[0]?.failure.phase, "heartbeat");
  assert.match(describe(lost[0]?.failure.error), /lease is stale or expired/);
});
