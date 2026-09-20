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

test("execution prompts default substantive work to the canvas without duplicating it in chat", () => {
  const input = context("Compare three launch ideas");
  for (const prompt of [buildAssistantPrompt("act", input), buildCanvasPrompt(input.causeEntries[0].text), buildRunnerPrompt(input)]) {
    assert.match(prompt, /Default to useful canvas artifacts/);
    assert.match(prompt, /even when the user does not explicitly say "draw" or "put it on the canvas"/);
    assert.match(prompt, /Honor explicit chat-only or no-edit requests/);
    assert.match(prompt, /Do not repeat the artifact's contents in chat/);
    assert.match(prompt, /prefer targeted updates over duplicates/);
  }
  assert.match(buildAssistantPrompt("act", input), /Prefer an act result with concrete operations/);
  assert.doesNotMatch(buildAssistantPrompt("act", input), /Requests to discuss a topic can receive a brief useful answer without canvas changes/);
});

test("execution prompts favor useful first drafts over unnecessary questions", () => {
  for (const prompt of [buildAssistantPrompt("act", {}), buildCanvasPrompt("Plan a launch"), buildRunnerPrompt(context("Plan a launch"))]) {
    assert.match(prompt, /Choose sensible defaults for scope, format, style and layout/);
    assert.match(prompt, /Ask at most one short, focused question only when a missing detail blocks safe, correct progress/);
    assert.match(prompt, /Do not end completed work with an unsolicited follow-up question/);
    assert.match(prompt, /Never invent measurements, sources, agreements, owners or dates/);
  }
});

test("canvas-first guidance preserves preview-only modes and concise chat exceptions", () => {
  for (const mode of ["context", "propose"] as const) {
    const prompt = buildAssistantPrompt(mode, {});
    assert.match(prompt, /NEVER return act or mutate the canvas/);
    assert.match(prompt, /Prefer silence/);
    assert.match(prompt, /prefer a concrete canvas draft or bounded offer over a long chat reply/);
    assert.doesNotMatch(prompt, /Prefer an act result with concrete operations/);
  }
  assert.match(buildRunnerPrompt({ ...context("Compare options"), trigger: { mode: "propose" } }), /In propose mode do not mutate: call proposeNode for human acceptance/);
  assert.match(CORE_INSTRUCTIONS, /greetings, simple factual answers, essential clarifications/);
  assert.match(CORE_INSTRUCTIONS, /When canvas edits are authorized/);
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
