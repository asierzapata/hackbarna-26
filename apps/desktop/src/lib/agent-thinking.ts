export function canvasThinkingTargets(name: string, input: unknown, result?: unknown): string[] | null {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const output = result && typeof result === "object" ? result as Record<string, unknown> : {};
  let candidates: unknown[];
  switch (name) {
    case "addNode": {
      const near = args.near as { shapeId?: unknown } | undefined;
      candidates = [output.shapeId ?? near?.shapeId];
      break;
    }
    case "addMermaidDiagram":
      candidates = Array.isArray(output.shapeIds) ? output.shapeIds : [];
      break;
    case "updateNode":
      candidates = [args.shapeId];
      break;
    case "connectNodes":
      candidates = [args.from, args.to];
      break;
    case "arrange":
    case "focusNodes":
    case "getCanvas":
      candidates = Array.isArray(args.shapeIds) ? args.shapeIds : [];
      break;
    case "removeNodes":
      return [];
    default:
      return null;
  }
  const ids = [...new Set(candidates.filter((id): id is string => typeof id === "string" && id.length > 0))];
  return ids.length ? ids : null;
}
