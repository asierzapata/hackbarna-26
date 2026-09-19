import { getServerRoomCanvas, fetchServerAsset } from "./api-client";
import { createOfflineCanvas, type CanvasCatalogEntry } from "./canvas-repository";

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

const ASSET_SRC_RE = /^\/assets\/([0-9a-f-]{36})$/;

export async function duplicateOnlineToOffline(params: {
  roomId: string;
  sourceName?: string;
}): Promise<CanvasCatalogEntry> {
  const { roomId, sourceName } = params;

  // 1. Fetch current server snapshot
  const { records } = await getServerRoomCanvas(roomId);

  // 2. Download and convert all referenced server assets to local self-contained data URLs
  const localizedRecords = await Promise.all(
    records.map(async (raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const rec = raw as Record<string, unknown>;
      if (rec.typeName !== "asset") return rec;

      const props = (rec.props as Record<string, unknown>) || {};
      const src = props.src;
      if (typeof src === "string") {
        const match = ASSET_SRC_RE.exec(src);
        if (match) {
          try {
            const assetBlob = await fetchServerAsset(match[1]);
            const dataUrl = await blobToDataUrl(assetBlob);
            return {
              ...rec,
              props: {
                ...props,
                src: dataUrl,
              },
            };
          } catch {
            throw new Error(`Could not save asset ${match[1]} for offline use`);
          }
        }
      }
      return rec;
    })
  );

  // 3. Allocate new local canvas
  const newCanvasId = crypto.randomUUID();
  const copyName = sourceName ? `${sourceName} (copy)` : "Canvas (copy)";

  // Persist the snapshot with the catalog entry before navigating. This keeps
  // duplication recoverable across a reload or app crash.
  const entry = await createOfflineCanvas({
    id: newCanvasId,
    name: copyName,
    initialRecords: localizedRecords,
  });

  return entry;
}
