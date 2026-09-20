/**
 * Renders nothing; exists so the capture hook can sit inside `CanvasProvider`
 * on routes whose page component is above the provider.
 */
import { useCanvas } from "./canvas-context";
import { useCanvasThumbnail } from "./use-canvas-thumbnail";

export function CanvasThumbnailCapture({ canvasId }: { canvasId: string }) {
  const { editor } = useCanvas();
  useCanvasThumbnail(editor, canvasId);
  return null;
}
