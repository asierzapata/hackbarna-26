/**
 * Creating a canvas in either mode.
 *
 * An online canvas is still a local canvas first: the catalog entry is the
 * thing the publish journal and the tldraw persistence key are both keyed on,
 * so there is no separate "born online" path to maintain. If publishing the
 * empty board fails we remove the entry again rather than leaving a stray
 * offline canvas the user never asked for — nothing has been drawn in it yet,
 * so there is nothing to lose.
 */
import { createOfflineCanvas, deleteCanvasEntry } from "./canvas-repository";
import { publishCanvas } from "./publish-canvas";

export type CanvasMode = "offline" | "online";

export interface CreatedCanvas {
  mode: CanvasMode;
  localCanvasId: string;
  /** Present only for online canvases; this is what the room route takes. */
  roomId?: string;
}

export async function createCanvas(
  mode: CanvasMode,
  name: string,
): Promise<CreatedCanvas> {
  const entry = await createOfflineCanvas({ name });

  if (mode === "offline") {
    return { mode: "offline", localCanvasId: entry.id };
  }

  try {
    const result = await publishCanvas({
      localCanvasId: entry.id,
      name: entry.name,
    });
    return {
      mode: "online",
      localCanvasId: entry.id,
      roomId: result.room.id,
    };
  } catch (err) {
    await deleteCanvasEntry(entry.id).catch(() => {
      // The entry is empty either way; a failed cleanup is not worth
      // shadowing the publish error the user actually needs to see.
    });
    throw err;
  }
}
