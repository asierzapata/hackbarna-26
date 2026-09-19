import { useEditor, useValue, type TLShapeId } from "tldraw";
import { useAgent } from "./agent-context";
import { InteractiveCanvas } from "./ui/interactive-canvas";

export function CanvasThinkingOverlay() {
  const editor = useEditor();
  const { thinkingShapeIds } = useAgent();
  const targets = useValue("AI thinking targets", () => {
    const pageIds = editor.getCurrentPageShapeIds();
    const viewport = editor.getViewportScreenBounds();
    const zoom = editor.getZoomLevel();
    return thinkingShapeIds.flatMap((id) => {
      if (!pageIds.has(id as TLShapeId)) return [];
      const bounds = editor.getShapePageBounds(id as TLShapeId);
      if (!bounds) return [];
      const point = editor.pageToViewport(bounds);
      const left = Math.max(-6, point.x - 6);
      const top = Math.max(-6, point.y - 6);
      const right = Math.min(viewport.w + 6, point.x + bounds.w * zoom + 6);
      const bottom = Math.min(viewport.h + 6, point.y + bounds.h * zoom + 6);
      return right > left && bottom > top ? [{ id, left, top, width: right - left, height: bottom - top }] : [];
    });
  }, [editor, thinkingShapeIds]);

  return <>{targets.map(({ id, ...style }) => (
    <div key={id} className="canvas-thinking" data-thinking-shape={id} style={style} aria-hidden="true">
      <InteractiveCanvas />
    </div>
  ))}</>;
}
