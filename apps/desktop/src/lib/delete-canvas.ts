/**
 * Removing a canvas from the catalog.
 *
 * The two modes mean genuinely different things, which is why they share an
 * entry point but not a strategy:
 *
 * - Offline canvases exist only here, so removing one destroys it. Nothing is
 *   recoverable afterwards; the caller is responsible for confirming first.
 * - Online canvases belong to everyone in the room. Removing one drops this
 *   installation's membership and its local cache — the room, its canvas and
 *   its thread carry on for the other members, and the invite code brings it
 *   back. It is a "leave", not a delete, and the UI must say so.
 */
import { leaveServerRoom } from "./api-client";
import {
  clearPublishJournal,
  deleteCanvasDocument,
  deleteCanvasEntry,
  getCanvasEntry,
} from "./canvas-repository";
import { deleteLocalThread } from "./local-thread-store";

/**
 * Everything derived from a canvas that this device stores separately from the
 * catalog entry. Each is best-effort: the entry is already gone by the time we
 * get here, so a failure leaks storage rather than stranding a card the user
 * cannot remove. Failing the whole call would be worse — it would suggest the
 * canvas is still there when it is not.
 */
async function deleteCanvasPayload(entry: {
  id: string;
  localPersistenceKey: string;
}): Promise<void> {
  const cleanups: [string, Promise<unknown>][] = [
    ["canvas document", deleteCanvasDocument(entry.localPersistenceKey)],
    ["thread", deleteLocalThread(entry.id)],
    ["publish journal", clearPublishJournal(entry.id)],
  ];
  for (const [what, work] of cleanups) {
    try {
      await work;
    } catch (err) {
      console.warn(`Could not delete the ${what} for canvas ${entry.id}:`, err);
    }
  }
}

/**
 * `id` is the catalog id offline and the room id online, matching the id the
 * catalog card is keyed by.
 */
export async function deleteCanvas(
  id: string,
  mode: "offline" | "online",
): Promise<void> {
  const entry = await getCanvasEntry(id);

  if (mode === "offline") {
    if (!entry) throw new Error(`Canvas ${id} not found in catalog`);
    // The card said offline but storage disagrees: another device published it
    // between the render and the click. Deleting the local copy would silently
    // leave the shared room behind, so make the caller re-read instead.
    if (entry.mode === "online") {
      throw new Error("This canvas is now online. Reload the catalog and try again.");
    }
    await deleteCanvasEntry(entry.id);
    await deleteCanvasPayload(entry);
    return;
  }

  // The server first: it owns membership, and it is the half that can fail.
  // Dropping the local cache before the request would hide a room the user is
  // still a member of, and it would come straight back on the next refresh.
  await leaveServerRoom(id);

  // A room joined on another device has no local entry here, which is normal.
  if (!entry) return;
  await deleteCanvasEntry(entry.id);
  await deleteCanvasPayload(entry);
}
