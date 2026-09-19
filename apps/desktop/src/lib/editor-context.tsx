import * as React from "react";

import { CanvasProvider, useCanvas } from "@/components/canvas-context";
import { createCanvasTools } from "@/nodes/tools";

export const EditorProvider = CanvasProvider;

export function useCanvasEditor() {
  return useCanvas().editor;
}

export function useSetCanvasEditor() {
  return useCanvas().setEditor;
}

export function useCanvasTools() {
  const editor = useCanvasEditor();
  return React.useMemo(() => (editor ? createCanvasTools(editor) : null), [editor]);
}
