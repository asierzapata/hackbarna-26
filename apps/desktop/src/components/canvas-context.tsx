/**
 * Holds the tldraw editor so the thread can reach the canvas.
 *
 * `ThreadActions.onJumpToNode` has been typed and wired through the thread for
 * a while with nothing behind it, because the editor instance only exists
 * inside `<Tldraw onMount>`. This lifts it to a provider that sits above both
 * panels, which is the whole seam: the thread stays transport agnostic and
 * still moves the camera.
 */
import * as React from "react";
import type { Editor, TLShapeId } from "tldraw";

import type { CanvasAnchor } from "@/lib/thread";

interface CanvasContextValue {
  editor: Editor | null;
  setEditor: (editor: Editor | null) => void;
  /** Selects the anchored shape and centres the camera on it. */
  jumpToNode: (anchor: CanvasAnchor) => void;
}

const CanvasContext = React.createContext<CanvasContextValue | null>(null);

export function CanvasProvider({ children }: { children: React.ReactNode }) {
  const [editor, setEditor] = React.useState<Editor | null>(null);

  const jumpToNode = React.useCallback(
    (anchor: CanvasAnchor) => {
      if (!editor) return;

      // Anchors carry the bare id; tldraw keys shapes as `shape:<id>`. An
      // anchor pointing at a node nobody created yet is normal (the thread
      // outlives any one board state), so a miss is a no-op, not an error.
      const id = (
        anchor.nodeId.startsWith("shape:") ? anchor.nodeId : `shape:${anchor.nodeId}`
      ) as TLShapeId;
      if (!editor.getShape(id)) return;

      editor.select(id);
      editor.zoomToSelection({ animation: { duration: 220 } });
    },
    [editor]
  );

  const value = React.useMemo(
    () => ({ editor, setEditor, jumpToNode }),
    [editor, jumpToNode]
  );

  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

export function useCanvas() {
  const ctx = React.useContext(CanvasContext);
  if (!ctx) throw new Error("useCanvas must be used inside a CanvasProvider");
  return ctx;
}
