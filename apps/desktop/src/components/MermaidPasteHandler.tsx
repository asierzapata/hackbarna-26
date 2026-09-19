import * as React from "react";
import {
  defaultHandleExternalTextContent,
  useEditor,
  useToasts,
  type TLTextExternalContent,
} from "tldraw";

import { isMermaidSource, stripMermaidFence } from "@/lib/mermaid";

function selectNewShapes(editor: ReturnType<typeof useEditor>, before: ReadonlySet<string>) {
  const newShapeIds = [...editor.getCurrentPageShapeIds()].filter((id) => !before.has(id));
  const pageId = editor.getCurrentPageId();
  const topLevelIds = newShapeIds.filter((id) => editor.getShape(id)?.parentId === pageId);
  if (topLevelIds.length) editor.setSelectedShapes(topLevelIds);
  else if (newShapeIds.length) editor.setSelectedShapes(newShapeIds);
}

export function MermaidPasteHandler() {
  const editor = useEditor();
  const { addToast } = useToasts();

  React.useEffect(() => {
    const handler = async (content: TLTextExternalContent) => {
      const plainText = content.sources?.find(
        (source) => source.type === "text" && source.subtype === "text",
      )?.data ?? content.text;
      const textToTest = isMermaidSource(plainText) ? plainText : content.text;

      if (!isMermaidSource(textToTest)) {
        await defaultHandleExternalTextContent(editor, content);
        return;
      }

      const before = new Set(editor.getCurrentPageShapeIds());
      try {
        const { createMermaidDiagram } = await import("@tldraw/mermaid");
        await createMermaidDiagram(editor, stripMermaidFence(textToTest), {
          ...(content.point ? { blueprintRender: { position: content.point } } : {}),
          onUnsupportedDiagram: async (svg) => {
            await editor.putExternalContent({
              type: "svg-text",
              text: svg,
              point: content.point,
              sources: content.sources,
            });
            addToast({
              id: "unsupported-mermaid-diagram",
              title: "Imported as SVG",
              description: "This Mermaid diagram type is not editable as native shapes yet.",
              severity: "warning",
            });
          },
        });
        selectNewShapes(editor, before);
      } catch (error) {
        console.error(error);
        await defaultHandleExternalTextContent(editor, content);
        addToast({
          id: "invalid-mermaid-diagram",
          title: "Mermaid diagram not imported",
          description: "The source could not be parsed, so it was added as text instead.",
          severity: "error",
        });
      }
    };

    editor.registerExternalContentHandler("text", handler);
    return () => {
      editor.registerExternalContentHandler("text", (content) =>
        defaultHandleExternalTextContent(editor, content),
      );
    };
  }, [addToast, editor]);

  return null;
}
