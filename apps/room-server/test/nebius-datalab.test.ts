import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { makeEvaluationRow, parseEvaluationRows, scenarios } from "./nebius-evaluation";
import { publishEvaluation } from "./nebius-datalab";

const fixture = () => scenarios.map(scenario => makeEvaluationRow(scenario, {
  triggerProbability: scenario.shouldTrigger ? 0.9 : 0,
}, scenario.shouldTrigger, 123, "test-model"));

test("historical live results remain unchanged after the classifier contract migration", () => {
  const rows = readFileSync(new URL("../../../nebius-classifier-evaluation.jsonl", import.meta.url), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(parseEvaluationRows(rows), rows);
  assert.match(fixture()[0].provenance, /binary-context-v1/);
});

test("evaluation publishing accepts only the complete synthetic suite and consistent scores", () => {
  const rows = fixture();
  assert.equal(parseEvaluationRows(rows).length, 6);
  for (const invalid of [rows.slice(1), [...rows.slice(1), rows[1]],
    rows.map((row, i) => i ? row : { ...row, input: "private meeting content" }),
    rows.map((row, i) => i ? row : { ...row, passed: false }),
    rows.map((row, i) => i ? row : { ...row, synthetic_only: false }),
    rows.map((row, i) => i ? row : { ...row, api_key: "private" }),
  ]) assert.throws(() => parseEvaluationRows(invalid));
  const failed = rows.map((row, i) => i ? row : { ...row, actual_trigger: true, passed: false });
  assert.equal(parseEvaluationRows(failed)[0].passed, false);
});

test("publisher creates a dataset once, waits for READY, and verifies all stored rows", async () => {
  let posted: any;
  let posts = 0, polls = 0;
  const result = await publishEvaluation("test-key", fixture(), {
    pause: async () => {},
    request: async (url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        assert.equal(path, "/v1/datasets");
        posts++;
        posted = JSON.parse(String(init.body));
        assert.equal(posted.rows.length, 6);
        assert.equal(posted.folder, "/");
        assert.equal(posted.schema.find((column: any) => column.name === "passed").type.name, "boolean");
        assert.equal(posted.schema.find((column: any) => column.name === "provider_ms").type.name, "integer");
        assert.equal(typeof posted.rows[0].model_decision, "string");
        return Response.json({ id: "dataset-test", status: "PENDING" });
      }
      if (path === "/v1/datasets") return Response.json({ data: [], has_more: false });
      if (path.endsWith("/content")) return Response.json({ rows: posted.rows.toReversed() });
      polls++;
      return Response.json({ status: polls === 1 ? "PENDING" : "READY" });
    },
  });
  assert.equal(posts, 1);
  assert.equal(polls, 2);
  assert.equal(result.id, "dataset-test");
  assert.equal(result.rowCount, 6);
  assert.equal(result.reused, false);
});

test("identical result publishing reuses and verifies an existing dataset, including paginated listings", async () => {
  let posted: any;
  await publishEvaluation("test-key", fixture(), { pause: async () => {}, request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") { posted = JSON.parse(String(init.body)); return Response.json({ id: "existing", status: "READY" }); }
    if (path === "/v1/datasets") return Response.json({ data: [], has_more: false });
    return Response.json({ rows: posted.rows });
  } });
  const result = await publishEvaluation("test-key", fixture(), { request: async (url, init) => {
    assert.notEqual(init?.method, "POST");
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/content")) return Response.json({ rows: posted.rows });
    if (!parsed.searchParams.has("after")) return Response.json({ data: [], has_more: true, last_id: "cursor" });
    assert.equal(parsed.searchParams.get("after"), "cursor");
    return Response.json({ data: [{ id: "existing", name: posted.name, status: "READY" }], has_more: false });
  } });
  assert.equal(result.reused, true);
});

test("publisher fails without retrying writes or exposing provider bodies", async () => {
  let posts = 0;
  await assert.rejects(publishEvaluation("test-key", fixture(), { request: async (_url, init) => {
    if (init?.method === "POST") { posts++; return new Response("private test-key", { status: 403 }); }
    return Response.json({ data: [], has_more: false });
  } }), { message: "Nebius Data Lab HTTP 403" });
  assert.equal(posts, 1);
  await assert.rejects(publishEvaluation("test-key", fixture(), { request: async () => { throw new Error("private test-key"); } }), /request failed; no write retry/);
  await assert.rejects(publishEvaluation("test-key", fixture(), { request: async (_url, init) => init?.method === "POST"
    ? Response.json({ id: "created", status: "FAILED", error: "private test-key" })
    : Response.json({ data: [], has_more: false }) }), /dataset created failed/);
});

test("publisher detects incomplete stored data rather than claiming success", async () => {
  await assert.rejects(publishEvaluation("test-key", fixture(), { request: async (url, init) => {
    if (init?.method === "POST") return Response.json({ id: "created", status: "READY" });
    return Response.json(new URL(String(url)).pathname.endsWith("/content") ? { rows: [] } : { data: [], has_more: false });
  } }), /stored rows do not match/);
});
