import { EntrySchema, type Entry } from "@kan/protocol";

export interface LocalThreadStorage {
  read(canvasId: string): Promise<Entry[]>;
  write(canvasId: string, entries: Entry[]): Promise<void>;
}

function openThreadDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kan-local-assistant", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("entries", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const localThreadStorage: LocalThreadStorage = {
  async read(canvasId) {
    const db = await openThreadDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("entries", "readonly");
      const request = tx.objectStore("entries").get(canvasId);
      request.onsuccess = () => {
        try { resolve(EntrySchema.array().parse(request.result?.entries ?? [])); }
        catch (error) { reject(error); }
      };
      tx.oncomplete = () => db.close();
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  },
  async write(canvasId, entries) {
    const db = await openThreadDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("entries", "readwrite");
      tx.objectStore("entries").put({ key: canvasId, entries: structuredClone(entries) });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error("Could not save the thread")); };
    });
  },
};

export async function localHumanMessages(canvasId: string) {
  const entries = await localThreadStorage.read(canvasId);
  const messages = entries.filter((entry): entry is Extract<Entry, { kind: "message" }> => entry.kind === "message");
  if (messages.length > 500) throw new Error("Publishing more than 500 messages is not supported; the local history is preserved.");
  return messages.map(({ id, text, at, anchors, source }) => ({ id, text, at, anchors, source }));
}

/**
 * Drops a canvas's offline thread. Not on `LocalThreadStorage`: the interface
 * is what `local-transport` swaps out in tests, and deletion is a catalog
 * concern rather than something a live thread ever does to itself.
 */
export async function deleteLocalThread(canvasId: string): Promise<void> {
  const db = await openThreadDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("entries", "readwrite");
    tx.objectStore("entries").delete(canvasId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error("Could not delete the thread")); };
  });
}
