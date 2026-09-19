import * as React from "react";
import {
  Tldraw,
  defaultBindingUtils,
  defaultShapeUtils,
  type Editor,
  type TLAssetStore,
} from "tldraw";
import { useSync } from "@tldraw/sync";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import "tldraw/tldraw.css";

import { shapeUtils } from "@/lib/canvas-shapes";
import { consumeCanvasInitialRecords } from "@/lib/canvas-repository";
import {
  createSocketTicket,
  fetchServerAsset,
  getRoomWebSocketUrl,
  uploadServerAsset,
} from "@/lib/api-client";
import { useCanvas } from "./canvas-context";

const assetUrls = getAssetUrlsByImport();
const syncShapeUtils = [...defaultShapeUtils, ...shapeUtils];

export function Canvas({ roomId, online = false }: { roomId: string; online?: boolean }) {
  return online ? <OnlineCanvas roomId={roomId} /> : <OfflineCanvas roomId={roomId} />;
}

function OfflineCanvas({ roomId }: { roomId: string }) {
  const { setEditor } = useCanvas();

  const onMount = React.useCallback(
    (editor: Editor) => {
      setEditor(editor);

      // Seed initial records if this canvas was duplicated or initialized with snapshot
      if (editor.getCurrentPageShapeIds().size === 0) {
        void consumeCanvasInitialRecords(roomId).then((initialRecords) => {
          if (initialRecords?.length) editor.store.put(initialRecords as any[]);
        });
      }
    },
    [roomId, setEditor]
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

const resolvedAssets = new Map<string, Promise<string>>();
const onlineAssetStore: TLAssetStore = {
  async upload(_asset, file) {
    const uploaded = await uploadServerAsset(file, file.type || "application/octet-stream");
    return { src: `/assets/${uploaded.id}` };
  },
  resolve(asset) {
    const src = asset.props.src;
    if (!src) return null;
    const match = /^\/assets\/([0-9a-f-]{36})$/.exec(src);
    if (!match) return src;
    let pending = resolvedAssets.get(match[1]);
    if (!pending) {
      pending = fetchServerAsset(match[1]).then((blob) => URL.createObjectURL(blob));
      resolvedAssets.set(match[1], pending);
    }
    return pending;
  },
};

function OnlineCanvas({ roomId }: { roomId: string }) {
  const { setEditor } = useCanvas();
  const getSyncUri = React.useCallback(async () => {
    const { ticket } = await createSocketTicket(roomId, "sync");
    return getRoomWebSocketUrl(roomId, "sync", ticket);
  }, [roomId]);
  const store = useSync({
    shapeUtils: syncShapeUtils,
    bindingUtils: defaultBindingUtils,
    assets: onlineAssetStore,
    uri: getSyncUri,
  });

  const onMount = React.useCallback((editor: Editor) => setEditor(editor), [setEditor]);
  React.useEffect(() => () => setEditor(null), [setEditor]);

  return (
    <section className="canvas" aria-label="Infinite canvas">
      <div className="canvas__viewport">
        <Tldraw
          key={roomId}
          store={store}
          assetUrls={assetUrls}
          shapeUtils={shapeUtils}
          onMount={onMount}
        />
      </div>
    </section>
  );
}
