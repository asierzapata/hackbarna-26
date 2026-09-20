import type { Mutation } from "@kan/protocol";

import type { AgentStep } from "./thread";

/**
 * Turning agent activity into the thread's step rail.
 *
 * Two sources feed the same list. A tool-driven turn reports ACP `tool_call`
 * updates as they happen, so the rail is live. A structured turn only reveals
 * what it did in its result, so its steps are synthesised from the mutations
 * once the turn ends. Both end up as `AgentStep[]`, and the card does not care
 * which produced them.
 *
 * Pure on purpose: no React, no DOM, so the wording is unit-testable.
 */

/** The shape of an ACP tool call, as the provider reports it. */
export interface ToolCallUpdate {
  id: string;
  title?: string;
  kind?: string;
  /** `pending` | `in_progress` | `completed` | `failed`, per ACP. */
  status: string;
}

/** Present and past wording for every canvas tool we expose. */
const toolWording: Record<string, [running: string, done: string]> = {
  getCanvas: ["Reading the canvas", "Read the canvas"],
  addNode: ["Adding a node", "Added a node"],
  addMermaidDiagram: ["Drawing a diagram", "Drew a diagram"],
  updateNode: ["Updating a node", "Updated a node"],
  removeNodes: ["Removing nodes", "Removed nodes"],
  connectNodes: ["Connecting nodes", "Connected nodes"],
  arrange: ["Arranging nodes", "Arranged nodes"],
  focusNodes: ["Moving the camera", "Moved the camera"],
  groupNodes: ["Grouping nodes", "Grouped nodes"],
};

/** Wording for the mutations a structured turn reports in its result. */
const mutationWording: Record<Mutation["type"], string> = {
  add: "Added a node",
  update: "Updated a node",
  connect: "Connected two nodes",
  arrange: "Arranged nodes",
  style: "Changed a colour",
  diagram: "Drew a diagram",
  label: "Renamed a node",
};

/**
 * Which canvas tool a call is about.
 *
 * Providers are inconsistent here: some send the bare tool name, others a
 * decorated title like `kan-canvas - addNode`. Matching on substring covers
 * both, and an unrecognised tool still gets a row from its own title rather
 * than being dropped.
 */
export function toolKey(call: ToolCallUpdate): string | undefined {
  const haystack = `${call.title ?? ""} ${call.id}`;
  return Object.keys(toolWording).find((name) => haystack.includes(name));
}

export function stepState(status: string): NonNullable<AgentStep["state"]> {
  switch (status) {
    case "completed":
      return "done";
    case "failed":
      return "error";
    case "in_progress":
      return "running";
    default:
      return "pending";
  }
}

/** Wording for a resolved tool, falling back to whatever the provider called it. */
function wording(key: string | undefined, title: string | undefined, state: AgentStep["state"]): string {
  if (key && toolWording[key]) {
    return toolWording[key][state === "done" || state === "error" ? 1 : 0];
  }
  return title?.trim() || "Working";
}

export function describeTool(call: ToolCallUpdate, state: AgentStep["state"]): string {
  return wording(toolKey(call), call.title, state);
}

/**
 * Upsert one tool call into the rail.
 *
 * `tool_call` and `tool_call_update` share an id and arrive in any order, and
 * a late update may carry no title, so fields are merged rather than replaced.
 */
export function applyToolCall(
  steps: readonly AgentStep[],
  call: ToolCallUpdate,
  now: number,
): AgentStep[] {
  const state = stepState(call.status);
  const index = steps.findIndex((step) => step.id === call.id);
  const previous = index === -1 ? undefined : steps[index];
  const startedAt = previous?.startedAt ?? now;
  const settled = state === "done" || state === "error";
  // A `tool_call_update` often carries neither title nor kind, so the tool
  // resolved on the first sighting is what keeps the row's wording right.
  const tool = toolKey(call) ?? previous?.tool ?? call.kind ?? "tool";
  const merged: AgentStep = {
    id: call.id,
    tool,
    summary: wording(tool, call.title ?? previous?.summary, state),
    target: previous?.target,
    state,
    startedAt,
    durationMs: settled ? (previous?.durationMs ?? now - startedAt) : undefined,
  };
  if (index === -1) return [...steps, merged];
  return steps.map((step, i) => (i === index ? merged : step));
}

/** Steps for a structured turn, which only reports what it did at the end. */
export function stepsFromMutations(operations: readonly Mutation[]): AgentStep[] {
  return operations.map((operation, index) => ({
    id: `mutation-${index}`,
    tool: operation.type,
    summary: mutationWording[operation.type],
    state: "done" as const,
  }));
}

/**
 * The one line of reasoning to show, from everything streamed so far.
 *
 * Thought chunks arrive a word or two at a time. Painting each chunk made the
 * line flash single tokens, which is unreadable and looks broken, so the
 * caller accumulates instead and this picks the last *finished* sentence: the
 * line then changes once per thought rather than once per token. A sentence
 * still being typed stays hidden behind the one before it.
 */
const SENTENCE = /[^.!?\u2026\n]+[.!?\u2026]+/g;

export function thoughtLine(buffer: string): string {
  const text = buffer.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentences = text.match(SENTENCE);
  if (sentences?.length) return sentences[sentences.length - 1].trim();
  // Some models never punctuate. Past a paragraph's worth, showing the
  // unfinished thought beats showing nothing at all for the whole turn.
  return text.length >= 100 ? text : "";
}

/** The one line shown while the turn runs. */
export function activityLabel(
  steps: readonly AgentStep[],
  thinking = false,
): string {
  const running = [...steps].reverse().find((step) => step.state === "running" || step.state === "pending");
  if (running) return running.summary;
  if (thinking) return "Thinking";
  return steps.length ? "Finishing up" : "Working";
}

/** The collapsed line shown once the turn is over. */
export function summaryLabel(steps: readonly AgentStep[], durationMs?: number): string {
  const parts: string[] = [];
  if (typeof durationMs === "number" && durationMs > 0) {
    parts.push(`Worked for ${(durationMs / 1000).toFixed(1)}s`);
  }
  if (steps.length) parts.push(`${steps.length} step${steps.length === 1 ? "" : "s"}`);
  const failed = steps.filter((step) => step.state === "error").length;
  if (failed) parts.push(`${failed} failed`);
  return parts.join(" · ") || "Done";
}
