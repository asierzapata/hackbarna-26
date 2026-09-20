import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  activityLabel,
  applyToolCall,
  describeTool,
  stepState,
  stepsFromMutations,
  summaryLabel,
  toolKey,
} from "../src/lib/agent-steps";
import { AgentActivity } from "../src/components/thread/AgentActivity";
import { ThreadProvider } from "../src/components/thread/thread-context";
import type { AgentStep } from "../src/lib/thread";

const thread = {
  participants: new Map(),
  currentUserId: "me",
};

function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    createElement(ThreadProvider, { value: thread as never, children: node })
  );
}

test("ACP statuses map onto step states", () => {
  assert.equal(stepState("pending"), "pending");
  assert.equal(stepState("in_progress"), "running");
  assert.equal(stepState("completed"), "done");
  assert.equal(stepState("failed"), "error");
  assert.equal(stepState("something-new"), "pending");
});

test("a decorated provider title still resolves to the canvas tool", () => {
  assert.equal(toolKey({ id: "call-1", title: "kan-canvas - addNode", status: "pending" }), "addNode");
  assert.equal(toolKey({ id: "getCanvas-7", status: "pending" }), "getCanvas");
  assert.equal(toolKey({ id: "call-2", title: "Read file", status: "pending" }), undefined);
});

test("wording moves from present to past as a step settles", () => {
  const call = { id: "c", title: "addNode", status: "in_progress" };
  assert.equal(describeTool(call, "running"), "Adding a node");
  assert.equal(describeTool(call, "done"), "Added a node");
});

test("an unknown tool keeps its own title rather than being dropped", () => {
  const steps = applyToolCall([], { id: "c", title: "Search the web", status: "in_progress" }, 0);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].summary, "Search the web");
});

test("a tool_call_update merges into the row it updates and times it", () => {
  const started = applyToolCall([], { id: "c", title: "addNode", status: "in_progress" }, 1000);
  // The update carries no title, which is exactly how providers send them.
  const finished = applyToolCall(started, { id: "c", status: "completed" }, 1600);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].summary, "Added a node");
  assert.equal(finished[0].state, "done");
  assert.equal(finished[0].durationMs, 600);
});

test("a structured turn gets its steps from the mutations it reports", () => {
  const steps = stepsFromMutations([
    { type: "style", shapeId: "shape:a", color: "red" },
    { type: "connect", from: "shape:a", to: "shape:b" },
  ] as never);
  assert.deepEqual(steps.map((step) => step.summary), ["Changed a colour", "Connected two nodes"]);
  assert.ok(steps.every((step) => step.state === "done"));
});

test("the live label follows the step that is actually running", () => {
  const steps: AgentStep[] = [
    { id: "a", tool: "getCanvas", summary: "Read the canvas", state: "done" },
    { id: "b", tool: "addNode", summary: "Adding a node", state: "running" },
  ];
  assert.equal(activityLabel(steps), "Adding a node");
  assert.equal(activityLabel([]), "Working");
  assert.equal(activityLabel([steps[0]], "weighing the options"), "Thinking");
});

test("the collapsed line counts steps and failures", () => {
  const steps: AgentStep[] = [
    { id: "a", tool: "addNode", summary: "Added a node", state: "done" },
    { id: "b", tool: "connectNodes", summary: "Connected nodes", state: "error" },
  ];
  assert.equal(summaryLabel(steps, 6100), "Worked for 6.1s · 2 steps · 1 failed");
});

test("a finished turn with no steps renders nothing at all", () => {
  assert.equal(render(createElement(AgentActivity, { steps: [], running: false })), "");
});

test("a running turn with no steps yet still says what it is doing", () => {
  const html = render(createElement(AgentActivity, { steps: [], running: true }));
  assert.match(html, /Working/);
  assert.match(html, /aria-live="polite"/);
});

test("a running turn shows its steps and one thought line", () => {
  const html = render(
    createElement(AgentActivity, {
      running: true,
      thought: "the two clusters are unrelated",
      steps: [
        { id: "a", tool: "getCanvas", summary: "Read the canvas", state: "done", durationMs: 300 },
        { id: "b", tool: "addNode", summary: "Adding a node", state: "running" },
      ],
    })
  );
  assert.match(html, /Read the canvas/);
  assert.match(html, /Adding a node/);
  assert.match(html, /the two clusters are unrelated/);
  assert.match(html, /0\.3s/);
});

test("a finished turn collapses, and a failed one does not", () => {
  const done: AgentStep[] = [{ id: "a", tool: "addNode", summary: "Added a node", state: "done" }];
  const collapsed = render(createElement(AgentActivity, { steps: done, running: false, durationMs: 2000 }));
  assert.match(collapsed, /Worked for 2\.0s/);
  assert.doesNotMatch(collapsed, /Added a node/);

  const failed: AgentStep[] = [
    { id: "a", tool: "addNode", summary: "Added a node", state: "error", error: "canvas is gone" },
  ];
  const open = render(createElement(AgentActivity, { steps: failed, running: false, durationMs: 2000 }));
  assert.match(open, /Added a node/);
  assert.match(open, /canvas is gone/);
});
