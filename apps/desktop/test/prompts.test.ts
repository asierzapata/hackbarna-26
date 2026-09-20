import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAssistantPrompt, buildCanvasPrompt, buildRunnerPrompt, compactAssistantContext, CORE_INSTRUCTIONS, isDiagramRequest } from "@kan/protocol";

const context = (text: string) => ({ trigger: { mode: "act", anchors: [] }, causeEntries: [{ id: "latest", kind: "message", text }], recentEntries: [], canvas: { shapes: [] } });

test("all execution prompts share the same core and only contextual mode prefers silence", () => {
  for (const prompt of [buildAssistantPrompt("act", {}), buildAssistantPrompt("context", {}), buildCanvasPrompt("draw"), buildRunnerPrompt(context("draw"))]) assert.ok(prompt.startsWith(CORE_INSTRUCTIONS));
  assert.match(buildAssistantPrompt("context", {}), /Prefer silence/);
  assert.doesNotMatch(buildAssistantPrompt("act", {}), /Prefer silence/);
  assert.doesNotMatch(buildAssistantPrompt("context", {}), /"type":"diagram"/);
});

test("drawing path omits unrelated rich node contracts without narrowing compound or edit requests", () => {
  assert.equal(isDiagramRequest(context("Draw a flowchart with branches")), true);
  const full = buildAssistantPrompt("act", context("Create a calendar and food options"));
  const drawing = buildAssistantPrompt("act", context("Draw a flowchart with branches"));
  assert.ok(drawing.length < full.length * 0.8);
  assert.doesNotMatch(drawing, /"type":"calendar"/);
  assert.match(drawing, /"type":"diagram"/);
  for (const text of ["Draw a calendar and food boxes", "Edit the existing diagram", "Recolor this diagram blue", "Draw a diagram and a markdown note"]) assert.equal(isDiagramRequest(context(text)), false);
  assert.equal(isDiagramRequest({ ...context("Draw this"), trigger: { anchors: ["shape:selected"] } }), false);
});

test("compact context removes duplicate causes, bookkeeping and provenance, not evidence", () => {
  const input = context("Draw a process");
  const value = compactAssistantContext({ ...input, recentEntries: [...input.causeEntries, { id: "trigger", kind: "trigger" }, { id: "prior", kind: "message", text: "Earlier evidence" }], canvas: { shapes: [{ id: "shape:a", type: "geo", props: { richText: "Evidence" }, meta: { provenance: { runId: "private-bookkeeping" } } }] } });
  const json = JSON.stringify(value);
  assert.equal(json.match(/Draw a process/g)?.length, 1);
  assert.match(json, /Earlier evidence/);
  assert.match(json, /Evidence/);
  assert.doesNotMatch(json, /private-bookkeeping/);
});
