import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentRequestError } from "@kan/protocol";
import { HttpError, requestJson, RunClient } from "../src/run-client";
import { createCanvasMcpServer } from "../src/canvas-mcp";

test("unsafe mutations are not replayed; safe retries reuse their operation ID", async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const bodies: unknown[] = [];
  globalThis.fetch = async (_input, init) => { bodies.push(init?.body); return new Response("{}", { status: 503 }); };
  await assert.rejects(requestJson("https://example.invalid", "not-logged", "POST", { draft: {} }, true), HttpError);
  assert.equal(bodies.length, 1);
  bodies.length = 0;
  await assert.rejects(requestJson("https://example.invalid", "not-logged", "POST", { id: randomUUID(), draft: {} }, true), HttpError);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("abort interrupts retry backoff and retains the actual cancellation", async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const controller = new AbortController(); let calls = 0;
  globalThis.fetch = async () => { calls++; queueMicrotask(() => controller.abort()); return new Response("{}", { status: 503 }); };
  await assert.rejects(requestJson("https://example.invalid", "not-logged", "GET", undefined, true, controller.signal));
  assert.equal(calls, 1);
});

test("transport failures preserve structured phase and uncertain mutation outcomes", async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { throw new Error("private connection details"); };
  await assert.rejects(requestJson("https://example.invalid", "not-logged", "POST", {}, false), (error: unknown) => {
    assert.ok(error instanceof AgentRequestError);
    assert.equal(error.failure.code, "TRANSPORT_FAILED");
    assert.equal(error.failure.outcome, "unknown");
    assert.ok(!JSON.stringify(error.failure).includes("private"));
    return true;
  });
});

test("real MCP tool errors retain codes, HTTP status and outcome without credentials", async (t) => {
  const run = new RunClient("https://example.invalid", randomUUID(), randomUUID(), "fixture-secret");
  run.canvas = async () => { throw new HttpError(403); };
  const server = createCanvasMcpServer(run, "act");
  const client = new Client({ name: "diagnostics-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(a); await client.connect(b);
  const result = await client.callTool({ name: "getCanvas", arguments: { scope: "summary" } });
  assert.equal(result.isError, true);
  const detail = JSON.parse((result.content as { text: string }[])[0].text);
  assert.equal(detail.code, "PERMISSION_DENIED");
  assert.equal(detail.httpStatus, 403);
  assert.equal(detail.outcome, "not_applied");
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
});
