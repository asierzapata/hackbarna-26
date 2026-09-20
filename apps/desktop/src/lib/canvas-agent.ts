import { z } from "zod";
import { toolSchemas } from "../nodes/schema";
import type { CanvasTools } from "../nodes/tools";
import type { ConversationLine } from "./conversation-script";

const descriptions: Record<keyof typeof toolSchemas, string> = {
  addNode: "Create a native tldraw geo shape or a markdown, chart, table, image, map, logo, timeline, or calendar node on the current canvas. Use draft {type: \"geo\", geo: \"rectangle\", text: \"Label\", w: 240, h: 120} for a box, or {type: \"geo\", geo: \"ellipse\", w: 160, h: 160} for a circle. Use unequal w and h for an oval. Use near to place related nodes beside an existing shape. Returns its shapeId.",
  addMermaidDiagram: "Create a Mermaid flowchart, sequence diagram, state diagram, or mindmap as native editable tldraw shapes, arrows, and groups. Pass the exact source in source; optional at is the top-left page position. Returns all created shapeIds.",
  updateNode: "Update an existing Kan node or normal tldraw box in place using its shapeId. For native geometric shapes (including stars) use type geo with text, color and/or geometry; e.g. patch {type: \"geo\", color: \"blue\"}. Prefer updating to creating duplicates.",
  removeNodes: "Remove explicitly requested nodes and their connections. Do not remove unrelated user work.",
  connectNodes: "Connect two existing shapes with an optional labelled arrow.",
  arrange: "Arrange the given shapes in a grid, row, or column without moving other shapes.",
  focusNodes: "Fit the specified existing current-page shapes in the camera without changing shapes or selection.",
  groupNodes: "Group two or more existing canvas nodes in a compact rounded container. Only the listed shapes are repositioned; returns the new group shapeId.",
  getCanvas: "Inspect the current canvas before acting. Summary includes node IDs, types, content and connections; full includes all props.",
};

export const canvasToolDefinitions = Object.entries(toolSchemas).map(
  ([name, schema]) => ({
    name,
    description: descriptions[name as keyof typeof toolSchemas],
    inputSchema: z.toJSONSchema(schema.extend({ requestId: z.uuid().optional().describe("Stable operation UUID. Reuse with identical arguments when retrying a mutation in this canvas session; never replay an unknown outcome with a new ID.") }), { target: "draft-7", io: "input" }),
  }),
);

export function executeCanvasTool(
  tools: CanvasTools,
  name: string,
  input: unknown,
) {
  if (!Object.prototype.hasOwnProperty.call(toolSchemas, name))
    throw new Error(`Unknown canvas tool: ${name}`);
  z.object({ requestId: z.uuid().optional() }).parse(input);
  const key = name as keyof typeof toolSchemas;
  const parsed = toolSchemas[key].parse(input);
  return (tools[key] as (input: unknown) => unknown)(parsed);
}

export function shouldActOnLine(line: ConversationLine) {
  return !!line.trigger && /^(node|action):/.test(line.trigger.label);
}

export { buildCanvasPrompt } from "@kan/protocol";
