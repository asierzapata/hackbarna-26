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
import { useValue, type Editor, type TLShapeId } from "tldraw";

import type { CanvasAnchor } from "@/lib/thread";
import { isKanShape } from "@/nodes/shapes/types";

interface CanvasContextValue {
  editor: Editor | null;
  setEditor: (editor: Editor | null) => void;
  /** Selects the anchored shape and centres the camera on it. */
  jumpToNode: (anchor: CanvasAnchor) => void;
  /** The current selection, as thread anchors. Tracks the editor reactively. */
  selectedAnchors: CanvasAnchor[];
  /** Node count for the thread footer, also reactive. */
  shapeCount: number;
  /** Human label for a shape id, or undefined if the board has no such node. */
  labelForNode: (nodeId: string) => string | undefined;
}

/** Prefers the node's own title over its raw shape id. */
function shapeLabel(editor: Editor, id: TLShapeId): string {
  const shape = editor.getShape(id);
  if (shape && isKanShape(shape)) {
    return shape.type === "kan-logo"
      ? shape.props.name || shape.props.domain
      : shape.props.title || id;
  }
  if (shape?.type !== "kan-node") return id;
  const draft = (shape.props as { draft?: { type: string; title?: string; label?: string } })
    .draft;
  return draft?.title ?? draft?.label ?? id;
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

  // tldraw state is reactive, not React state: reading it during render gives
  // a value that never updates. `useValue` subscribes, so the composer's
  // selection hint and the footer's node count follow the canvas live.
  const selectedAnchors = useValue<CanvasAnchor[]>(
    "selected anchors",
    () =>
      (editor?.getSelectedShapeIds() ?? []).map((id) => ({
        nodeId: id,
        label: editor ? shapeLabel(editor, id) : id,
      })),
    [editor]
  );

  const shapeCount = useValue(
    "shape count",
    () => editor?.getCurrentPageShapeIds().size ?? 0,
    [editor]
  );

  const labelForNode = React.useCallback(
    (nodeId: string) => {
      if (!editor) return undefined;
      const id = (
        nodeId.startsWith("shape:") ? nodeId : `shape:${nodeId}`
      ) as TLShapeId;
      return editor.getShape(id) ? shapeLabel(editor, id) : undefined;
    },
    [editor]
  );

  const value = React.useMemo(
    () => ({
      editor,
      setEditor,
      jumpToNode,
      selectedAnchors,
      shapeCount,
      labelForNode,
    }),
    [editor, jumpToNode, selectedAnchors, shapeCount, labelForNode]
  );

  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

export function useCanvas() {
  const ctx = React.useContext(CanvasContext);
  if (!ctx) throw new Error("useCanvas must be used inside a CanvasProvider");
  return ctx;
}
