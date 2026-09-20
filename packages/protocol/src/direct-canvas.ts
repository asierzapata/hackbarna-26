import { AssistantResultSchema, type AssistantResult } from "./index";

type Context = { trigger?: { anchors?: string[]; approvedRequest?: string }; causeEntries?: Array<{ kind?: string; text?: string }>; canvas?: { truncated?: boolean; shapes?: Array<{ id: string; type?: string; props?: Record<string, unknown>; isLocked?: boolean }> } };
export function isDrawingResult(result: AssistantResult) {
  return result.kind === "act" && result.operations.every(operation => ["diagram", "style", "label"].includes(operation.type));
}

const COLORS = "black|grey|light-violet|violet|blue|light-blue|yellow|orange|green|light-green|light-red|red|white";

export function directCanvasResult(mode: string, value: unknown): AssistantResult | undefined {
  if (mode !== "act" || !value || typeof value !== "object") return;
  const context = value as Context;
  const messages = context.causeEntries?.filter(entry => entry.kind === "message") ?? [];
  const request = context.trigger?.approvedRequest ?? messages[messages.length - 1]?.text;
  if (typeof request !== "string") return;
  const text = request.trim().replace(/^(?:@(?:kan|assistant)|hey\s+kan)\b[\s,:!]*/i, "").replace(/[.!]$/, "").trim();
  const create = text.match(new RegExp(`^(?:draw|create|make) (?:a|one) (${COLORS}) (box|rectangle|circle)$`, "i"));
  if (create) return AssistantResultSchema.parse({ kind: "act", text: `Created a ${create[1].toLowerCase()} ${create[2].toLowerCase()}.`, sources: [], operations: [{ type: "diagram", nodes: [{ id: "shape", label: create[2].toLowerCase() === "circle" ? "Circle" : "Box", geo: create[2].toLowerCase() === "circle" ? "ellipse" : "rectangle", color: create[1].toLowerCase() }], edges: [] }] });
  const color = text.match(new RegExp(`^(?:make|color|colour|paint) (it|this|the box|the rectangle|the circle|the shape|the selected shape) (${COLORS})$`, "i"));
  if (!color || !Array.isArray(context.canvas?.shapes)) return;
  const anchors = context.trigger?.anchors ?? [];
  if (anchors.length > 1 || (context.canvas.truncated && !anchors.length)) return;
  const candidates = context.canvas.shapes.filter(shape => {
    if (shape.type !== "geo" || shape.isLocked || (anchors.length && !anchors.includes(shape.id))) return false;
    if (/box|rectangle/i.test(color[1])) return shape.props?.geo === "rectangle";
    if (/circle/i.test(color[1])) return shape.props?.geo === "ellipse" && shape.props?.w === shape.props?.h;
    return anchors.length === 1;
  });
  if (candidates.length !== 1) return;
  return AssistantResultSchema.parse({ kind: "act", text: `Changed the color to ${color[2].toLowerCase()}.`, sources: [], operations: [{ type: "style", shapeId: candidates[0].id, color: color[2].toLowerCase() }] });
}
