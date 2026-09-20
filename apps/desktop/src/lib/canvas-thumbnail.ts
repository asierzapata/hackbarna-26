/**
 * Catalog previews, rendered from the live editor.
 *
 * There is no server-side renderer, so a preview only exists for a canvas this
 * device has opened — an online canvas you were invited to but never opened
 * shows the placeholder until you do. Capture is best effort throughout: a
 * failed export must never interrupt drawing.
 */
import type { Editor } from "tldraw";

import { saveCanvasThumbnail } from "./canvas-repository";

/** Longest edge of the stored image, in CSS pixels. Cards render at ~320px. */
const MAX_EDGE = 512;

export async function renderCanvasThumbnail(
  editor: Editor,
): Promise<string | null> {
  const shapeIds = [...editor.getCurrentPageShapeIds()];
  if (shapeIds.length === 0) return null;

  const bounds = editor.getCurrentPageBounds();
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;

  // `scale` shrinks the export to the card's size rather than the board's, so
  // a sprawling canvas does not become a multi-megabyte data URL in IndexedDB.
  const scale = Math.min(1, MAX_EDGE / Math.max(bounds.width, bounds.height));

  const result = await editor.toImageDataUrl(shapeIds, {
    format: "jpeg",
    quality: 0.72,
    background: true,
    padding: 24,
    pixelRatio: 1,
    scale,
    darkMode: false,
  });

  return result.url || null;
}

/** Resolves true only when a preview was actually stored. */
export async function captureCanvasThumbnail(
  editor: Editor,
  canvasId: string,
): Promise<boolean> {
  try {
    const url = await renderCanvasThumbnail(editor);
    if (!url) return false;
    await saveCanvasThumbnail(canvasId, url);
    return true;
  } catch (err) {
    console.warn(`Could not render preview for canvas ${canvasId}:`, err);
    return false;
  }
}
