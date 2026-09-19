import * as React from "react";
import { Tldraw, createShapeId, type Editor } from "tldraw";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import "tldraw/tldraw.css";

import { shapeUtils } from "@/lib/canvas-shapes";
import { seedShapes } from "@/lib/canvas-fixtures";
import { useCanvas } from "./canvas-context";

const assetUrls = getAssetUrlsByImport();

export function Canvas({ roomId }: { roomId: string }) {
  const { setEditor } = useCanvas();

  const onMount = React.useCallback(
    (editor: Editor) => {
      setEditor(editor);

      // Until the sync server lands, a room is a local persistence key. Seeding
      // only an empty board keeps a reload from stacking duplicates, and gives
      // the thread's anchor chips something real to jump to.
      if (editor.getCurrentPageShapeIds().size === 0) {
        editor.createShapes(
          seedShapes.map((seed) => ({
            id: createShapeId(seed.id),
            type: "kan-node" as const,
            x: seed.x,
            y: seed.y,
            props: { w: seed.w, h: seed.h, draft: seed.draft },
          }))
        );
      }
    },
    [setEditor]
  );

  React.useEffect(() => () => setEditor(null), [setEditor]);

  return (
    <section className="canvas" aria-label="Infinite canvas">
      <div className="canvas__viewport">
        <Tldraw
          // Remounts the editor on a room change, so two rooms never share a
          // store. Swaps for `store={useSync(...)}` when the server exists.
          key={roomId}
          persistenceKey={`kan-room-${roomId}`}
          assetUrls={assetUrls}
          shapeUtils={shapeUtils}
          onMount={onMount}
        />
      </div>
    </section>
  );
}
