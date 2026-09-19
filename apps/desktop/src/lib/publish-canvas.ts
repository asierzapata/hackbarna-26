import type { Editor } from "tldraw";
import type { Room } from "@kan/protocol";
import {
  getCanvasEntry,
  markCanvasOnline,
  savePublishJournal,
  getPublishJournal,
  clearPublishJournal,
  type PublishJournal,
} from "./canvas-repository";
import {
  ensureBackendIdentity,
  publishServerRoom,
  uploadServerAsset,
  listServerRooms,
  getBackendBaseUrl,
} from "./api-client";

const DOC_TYPE_NAMES = new Set(["document", "page", "shape", "binding", "asset"]);
const ASSET_SRC_RE = /^\/assets\/([0-9a-f-]{36})$/;

const activePublishLocks = new Set<string>();

export interface PublishCanvasOptions {
  localCanvasId: string;
  name?: string;
  editor?: Editor | null;
}

export interface PublishCanvasResult {
  room: Room;
  created: boolean;
}

async function dataUrlToBlob(dataUrl: string): Promise<{ blob: Blob; contentType: string }> {
  const parts = dataUrl.split(",");
  const mimeMatch = parts[0].match(/:(.*?);/);
  const contentType = mimeMatch ? mimeMatch[1] : "image/png";
  const bstr = atob(parts[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return { blob: new Blob([u8arr], { type: contentType }), contentType };
}

async function resolveAssetBlob(src: string): Promise<{ blob: Blob; contentType: string }> {
  if (src.startsWith("data:")) {
    return dataUrlToBlob(src);
  }
  if (src.startsWith("blob:")) {
    const res = await fetch(src);
    const blob = await res.blob();
    return { blob, contentType: blob.type || "image/png" };
  }
  throw new Error(`Unsupported local asset source: ${src.slice(0, 30)}...`);
}

function extractDocumentRecordsFromEditor(editor: Editor): Record<string, unknown>[] {
  const snapshot = editor.getSnapshot();
  const rawRecords = Object.values(snapshot.document.store) as unknown as Record<string, unknown>[];
  return rawRecords.filter((rec) => {
    const typeName = rec.typeName as string | undefined;
    return typeName && DOC_TYPE_NAMES.has(typeName);
  });
}

export async function publishCanvas(options: PublishCanvasOptions): Promise<PublishCanvasResult> {
  const { localCanvasId } = options;

  if (activePublishLocks.has(localCanvasId)) {
    throw new Error("A publish operation is already in progress for this canvas");
  }

  activePublishLocks.add(localCanvasId);

  try {
    const entry = await getCanvasEntry(localCanvasId);
    if (!entry) {
      throw new Error(`Canvas ${localCanvasId} not found in catalog`);
    }

    if (entry.mode === "online" && entry.roomId) {
      // Already online
      return {
        room: {
          id: entry.roomId,
          localCanvasId,
          name: entry.name,
          code: entry.roomCode ?? "",
          createdBy: "",
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          assistantPaused: false,
        },
        created: false,
      };
    }

    const canvasName = options.name?.trim() || entry.name;
    const backendOrigin = getBackendBaseUrl();

    // 1. Check for unfinished journal from previous interrupted publish
    const existingJournal = await getPublishJournal(localCanvasId);
    if (existingJournal && existingJournal.resultRoomId) {
      // Reconcile: we know the server already assigned a roomId
      await markCanvasOnline(localCanvasId, existingJournal.resultRoomId, existingJournal.resultRoomCode);
      await clearPublishJournal(localCanvasId);
      return {
        room: {
          id: existingJournal.resultRoomId,
          localCanvasId,
          name: canvasName,
          code: existingJournal.resultRoomCode ?? "",
          createdBy: "",
          createdAt: entry.createdAt,
          updatedAt: new Date().toISOString(),
          assistantPaused: false,
        },
        created: false,
      };
    }

    // 2. Ensure backend identity
    await ensureBackendIdentity();

    // Check if the server already owns a room with this localCanvasId
    try {
      const serverRooms = await listServerRooms();
      const match = serverRooms.find((r) => r.localCanvasId === localCanvasId);
      if (match) {
        await markCanvasOnline(localCanvasId, match.id, match.code);
        await clearPublishJournal(localCanvasId);
        return {
          room: {
            id: match.id,
            localCanvasId,
            name: match.name,
            code: match.code,
            createdBy: match.createdBy,
            createdAt: match.createdAt,
            updatedAt: match.updatedAt,
            assistantPaused: match.assistantPaused ?? false,
          },
          created: false,
        };
      }
    } catch {
      // Disregard list error and continue with publish
    }

    // 3. Extract document records
    let records: Record<string, unknown>[] = [];
    if (options.editor) {
      records = extractDocumentRecordsFromEditor(options.editor);
    } else if (existingJournal?.records) {
      records = existingJournal.records as Record<string, unknown>[];
    }

    // 4. Record journal in preparing stage
    const journal: PublishJournal = {
      localCanvasId,
      backendOrigin,
      stage: "preparing",
      name: canvasName,
      records,
      updatedAt: new Date().toISOString(),
    };
    await savePublishJournal(journal);

    // 5. Upload local assets and rewrite src
    const assetIds: string[] = [];
    const processedRecords = await Promise.all(
      records.map(async (rec) => {
        if (rec.typeName !== "asset") return rec;
        const props = (rec.props as Record<string, unknown>) || {};
        const src = props.src;
        if (typeof src !== "string" || !src) return rec;

        // Check if already an owned backend asset
        const existingMatch = ASSET_SRC_RE.exec(src);
        if (existingMatch) {
          assetIds.push(existingMatch[1]);
          return rec;
        }

        // Upload local blob or data URL
        if (src.startsWith("data:") || src.startsWith("blob:")) {
          const { blob, contentType } = await resolveAssetBlob(src);
          const uploadResult = await uploadServerAsset(blob, contentType);
          assetIds.push(uploadResult.id);
          return {
            ...rec,
            props: {
              ...props,
              src: `/assets/${uploadResult.id}`,
            },
          };
        }

        return rec;
      })
    );

    journal.stage = "assets_uploaded";
    journal.records = processedRecords;
    journal.assetIds = assetIds;
    journal.updatedAt = new Date().toISOString();
    await savePublishJournal(journal);

    // 6. Validate limits
    if (processedRecords.length > 5000) {
      throw new Error(`Cannot publish: canvas contains ${processedRecords.length} records (maximum is 5,000)`);
    }
    if (assetIds.length > 100) {
      throw new Error(`Cannot publish: canvas contains ${assetIds.length} assets (maximum is 100)`);
    }

    // 7. Dispatch POST /rooms
    journal.stage = "dispatched";
    await savePublishJournal(journal);

    const publishResult = await publishServerRoom({
      localCanvasId,
      name: canvasName,
      records: processedRecords,
      assetIds,
    });

    const room = publishResult.room;

    // 8. Commit online mode atomically
    journal.stage = "completed";
    journal.resultRoomId = room.id;
    journal.resultRoomCode = room.code;
    journal.updatedAt = new Date().toISOString();
    await savePublishJournal(journal);

    await markCanvasOnline(localCanvasId, room.id, room.code);
    await clearPublishJournal(localCanvasId);

    return publishResult;
  } catch (err) {
    // If ambiguous failure after dispatch, check if the room was created
    try {
      const serverRooms = await listServerRooms();
      const match = serverRooms.find((r) => r.localCanvasId === localCanvasId);
      if (match) {
        await markCanvasOnline(localCanvasId, match.id, match.code);
        await clearPublishJournal(localCanvasId);
        return {
          room: {
            id: match.id,
            localCanvasId,
            name: match.name,
            code: match.code,
            createdBy: match.createdBy,
            createdAt: match.createdAt,
            updatedAt: match.updatedAt,
            assistantPaused: match.assistantPaused ?? false,
          },
          created: false,
        };
      }
    } catch {
      // Re-throw original error
    }
    throw err;
  } finally {
    activePublishLocks.delete(localCanvasId);
  }
}
