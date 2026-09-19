import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRequestError, createDiagnosticBuffer, failure, normalizeFailure, sanitizeDiagnostic } from "@kan/protocol";
import { executeInstrumentedTool } from "../src/lib/tool-execution";

test("diagnostics whitelist metadata and bound retention without payloads or error text", () => {
  const buffer = createDiagnosticBuffer(2);
  const raw = { id: "one", at: 1, event: "tool.failed", source: "frontend" as const, turnId: "turn", tool: "addNode", arguments: { secret: "private" }, failure: { ...failure("TOOL_EXECUTION_FAILED", "execution"), message: "Bearer private" } };
  buffer.add(raw);
  assert.ok(!JSON.stringify(buffer.snapshot()).includes("private"));
  buffer.add({ ...raw, id: "two" }); buffer.add({ ...raw, id: "three" }); buffer.add({ ...raw, id: "three" });
  assert.deepEqual(buffer.snapshot().map((e) => e.id), ["two", "three"]);
  assert.equal(sanitizeDiagnostic({ ...raw, tool: "secret tool title" }).tool, "unknown");
});

test("validation retains field paths, not invalid values; cancellation is distinct", () => {
  const value = normalizeFailure({ issues: [{ path: ["draft", "events", 0, "start"], code: "invalid_format", input: "private" }] }, "execution");
  assert.equal(value.code, "TOOL_VALIDATION_FAILED");
  assert.equal(value.outcome, "not_applied");
  assert.deepEqual(value.issues, [{ path: "draft.events.0.start", code: "invalid_format" }]);
  assert.equal(normalizeFailure(new DOMException("cancelled", "AbortError"), "agent").code, "CANCELLED");
});

test("execution records validation and acknowledges a structured failure", async () => {
  const events: string[] = []; let sent: unknown;
  await executeInstrumentedTool({ requestId: "r", turnId: "t", name: "addNode", arguments: {}, expiresAt: Date.now() + 1000 }, {
    active: () => true,
    execute: () => { throw { issues: [{ path: ["draft"], code: "invalid_type" }] }; },
    deliver: async (value) => { sent = value; },
    record: (event) => events.push(event.event),
  });
  assert.equal((sent as { error: { code: string } }).error.code, "TOOL_VALIDATION_FAILED");
  assert.deepEqual(events, ["tool.execution_started", "tool.validation_failed", "tool.result_acknowledged"]);
});

test("oversized success reports applied outcome instead of a swallowed delivery timeout", async () => {
  let sent: { result: unknown; error?: { code: string; outcome: string } } | undefined;
  await executeInstrumentedTool({ requestId: "r", turnId: "t", name: "addNode", arguments: {}, expiresAt: Date.now() + 1000 }, {
    active: () => true, execute: () => "x".repeat(2 * 1024 * 1024),
    deliver: async (value) => { sent = value; }, record: () => {},
  });
  assert.equal(sent?.result, null);
  assert.equal(sent?.error?.code, "RESULT_TOO_LARGE");
  assert.equal(sent?.error?.outcome, "applied");
});

test("delivery failures are recorded immediately and surfaced, without repeating execution", async () => {
  let count = 0; const events: string[] = [];
  await assert.rejects(executeInstrumentedTool({ requestId: "r", turnId: "t", name: "addNode", arguments: {}, expiresAt: Date.now() + 1000 }, {
    active: () => true, execute: () => { count++; return {}; },
    deliver: async () => { throw new Error("disconnected"); }, record: (event) => events.push(event.event),
  }), (error: unknown) => error instanceof AgentRequestError && error.failure.code === "RESULT_DELIVERY_FAILED" && error.failure.outcome === "applied");
  assert.equal(count, 1);
  assert.ok(events.includes("tool.result_delivery_failed"));
});

test("expired or cancelled tools cannot commit after an asynchronous wait", async () => {
  let active = true; let mutations = 0; let sent: unknown;
  await executeInstrumentedTool({ requestId: "r", turnId: "t", name: "addMermaidDiagram", arguments: {}, expiresAt: Date.now() + 1000 }, {
    active: () => active,
    execute: async (_name, _input, assertActive) => { await Promise.resolve(); active = false; assertActive(); mutations++; },
    deliver: async (value) => { sent = value; }, record: () => {},
  });
  assert.equal(mutations, 0);
  assert.equal((sent as { error: { code: string } }).error.code, "STALE_TURN");
});
