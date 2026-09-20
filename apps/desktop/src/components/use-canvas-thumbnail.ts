/**
 * Keeps the catalog preview for a canvas roughly current while it is open.
 *
 * Exporting an image re-renders every shape, so this is paced twice over: a
 * debounce so a drag produces one capture instead of sixty, and a floor on the
 * gap between captures so a long editing session cannot turn into a render
 * loop. Both are deliberately generous — a preview that is a minute stale is
 * invisible to the user, a stuttering canvas is not.
 */
import * as React from "react";
import type { Editor } from "tldraw";

import { captureCanvasThumbnail } from "@/lib/canvas-thumbnail";

const IDLE_DELAY_MS = 3000;
const MIN_INTERVAL_MS = 20_000;
/** Give the first paint (and, online, the first sync) time to land. */
const INITIAL_DELAY_MS = 2500;

export function useCanvasThumbnail(editor: Editor | null, canvasId: string) {
  React.useEffect(() => {
    if (!editor) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastCaptureAt = 0;
    let capturing = false;

    const capture = async () => {
      if (disposed || capturing) return;
      capturing = true;
      try {
        // Only a capture that stored something counts against the interval.
        // An empty board renders nothing, and charging it to the budget would
        // push the first real preview a full interval into the session.
        if (await captureCanvasThumbnail(editor, canvasId)) {
          lastCaptureAt = Date.now();
        }
      } finally {
        capturing = false;
      }
    };

    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void capture(), delay);
    };

    schedule(INITIAL_DELAY_MS);

    const unlisten = editor.store.listen(
      () => {
        const sinceLast = Date.now() - lastCaptureAt;
        schedule(Math.max(IDLE_DELAY_MS, MIN_INTERVAL_MS - sinceLast));
      },
      // Presence and camera changes are not worth a re-render; only the
      // document itself changes what the preview would show.
      { scope: "document", source: "all" },
    );

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten();
    };
  }, [editor, canvasId]);
}
