import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasToolDefinitions, executeCanvasTool, buildCanvasPrompt, shouldActOnLine } from "../src/lib/canvas-agent";
import { hackathonConversation } from "../src/lib/conversation-script";

test("MCP exposes the seven validated canvas tools with calendar, map, and native geo schemas", () => {
  assert.deepEqual(canvasToolDefinitions.map(({ name }) => name).sort(), ["addNode", "arrange", "connectNodes", "focusNodes", "getCanvas", "removeNodes", "updateNode"]);
  const add = canvasToolDefinitions.find(({ name }) => name === "addNode")!;
  assert.match(JSON.stringify(add.inputSchema), /calendar/);
  assert.match(JSON.stringify(add.inputSchema), /map/);
  assert.match(JSON.stringify(add.inputSchema), /geo/);
  assert.equal(add.inputSchema.type, "object");
  const focus = canvasToolDefinitions.find(({ name }) => name === "focusNodes")!;
  assert.match(JSON.stringify(focus.inputSchema), /shapeIds/);
});

test("dispatch rejects unknown tools and invalid input before any mutation", () => {
  const calls: unknown[] = [];
  const tools = { addNode: (input: unknown) => { calls.push(input); return { shapeId: "shape:created" }; } } as Parameters<typeof executeCanvasTool>[0];
  assert.throws(() => executeCanvasTool(tools, "constructor", {}), /Unknown canvas tool/);
  assert.throws(() => executeCanvasTool(tools, "addNode", { draft: { type: "calendar", title: "Dates", events: [{ id: "bad", title: "Bad", start: "2026-02-30" }] } }));
  assert.equal(calls.length, 0);
  assert.deepEqual(executeCanvasTool(tools, "addNode", { draft: { type: "calendar", title: "Dates", events: [{ id: "day1", title: "Day one", start: "2026-09-19" }, { id: "day2", title: "Day two", start: "2026-09-20" }] } }), { shapeId: "shape:created" });
  assert.equal(calls.length, 1);
});

test("dispatch validates focusNodes before calling the canvas tool", () => {
  const calls: unknown[] = [];
  const tools = {
    focusNodes: (input: unknown) => {
      calls.push(input);
      return { shapeIds: ["shape:focused"], bounds: { x: 0, y: 0, w: 10, h: 10 } };
    },
  } as Parameters<typeof executeCanvasTool>[0];
  assert.throws(() => executeCanvasTool(tools, "focusNodes", { shapeIds: [] }));
  assert.equal(calls.length, 0);
  assert.deepEqual(executeCanvasTool(tools, "focusNodes", { shapeIds: ["shape:focused"] }), {
    shapeIds: ["shape:focused"],
    bounds: { x: 0, y: 0, w: 10, h: 10 },
  });
  assert.equal(calls.length, 1);
});

test("conversation triggers request calendar, map and sponsors without duplicate decision turns", () => {
  const actionable = hackathonConversation.lines.filter(shouldActOnLine);
  assert.deepEqual(actionable.map(({ trigger }) => trigger?.label), ["node:calendar", "action:show-map", "node:sponsors"]);
  const index = hackathonConversation.lines.indexOf(actionable[1]);
  const prompt = buildCanvasPrompt(actionable[1].text, hackathonConversation.lines.slice(0, index + 1));
  assert.match(prompt, /19-20 september/);
  assert.match(prompt, /glovo/i);
  assert.match(prompt, /norrsken/i);
  assert.doesNotMatch(prompt, /preply/i);
  assert.match(prompt, /getCanvas/);
  assert.match(prompt, /focusNodes/);
  assert.match(prompt, /native tldraw geo shapes/);
});
