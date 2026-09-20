/**
 * Lightweight in-memory IndexedDB shim for Node.js unit tests.
 */
class MockRequest<T> {
  result: T = undefined as unknown as T;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;

  succeed(val: T) {
    this.result = val;
    queueMicrotask(() => this.onsuccess?.());
  }

  fail(err: Error) {
    this.error = err;
    queueMicrotask(() => this.onerror?.());
  }
}

class MockIndex {
  constructor(private store: MockObjectStore, private keyPath: string) {}

  get(key: unknown) {
    const req = new MockRequest<unknown>();
    queueMicrotask(() => {
      for (const val of this.store.data.values()) {
        if (typeof val === "object" && val !== null && (val as Record<string, unknown>)[this.keyPath] === key) {
          req.succeed(val);
          return;
        }
      }
      req.succeed(undefined);
    });
    return req;
  }
}

class MockObjectStore {
  data = new Map<string, unknown>();
  indexes = new Map<string, MockIndex>();

  constructor(public name: string, public keyPath?: string) {}

  createIndex(name: string, keyPath: string) {
    const idx = new MockIndex(this, keyPath);
    this.indexes.set(name, idx);
    return idx;
  }

  index(name: string) {
    const idx = this.indexes.get(name);
    if (!idx) throw new Error(`Index ${name} not found`);
    return idx;
  }

  get(key: string) {
    const req = new MockRequest<unknown>();
    queueMicrotask(() => {
      req.succeed(this.data.get(String(key)));
    });
    return req;
  }

  getAll() {
    const req = new MockRequest<unknown[]>();
    queueMicrotask(() => {
      req.succeed(Array.from(this.data.values()));
    });
    return req;
  }

  put(value: unknown, key?: string) {
    const req = new MockRequest<string>();
    queueMicrotask(() => {
      let actualKey = key;
      if (!actualKey && this.keyPath && typeof value === "object" && value !== null) {
        actualKey = String((value as Record<string, unknown>)[this.keyPath]);
      }
      if (!actualKey) actualKey = "default";
      this.data.set(actualKey, value);
      req.succeed(actualKey);
    });
    return req;
  }

  delete(key: string) {
    const req = new MockRequest<void>();
    queueMicrotask(() => {
      this.data.delete(String(key));
      req.succeed(undefined);
    });
    return req;
  }
}

class MockDatabase {
  objectStores = new Map<string, MockObjectStore>();

  constructor(public name: string, public version: number) {}

  /** Real code closes its connections; the shim has none to close. */
  close() {}

  get objectStoreNames() {
    return {
      contains: (n: string) => this.objectStores.has(n),
    };
  }

  createObjectStore(name: string, options?: { keyPath?: string }) {
    const store = new MockObjectStore(name, options?.keyPath);
    this.objectStores.set(name, store);
    return store;
  }

  transaction(storeNames: string | string[], mode: "readonly" | "readwrite") {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const self = this;
    const tx = {
      mode,
      error: null as Error | null,
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      objectStore(name: string) {
        const s = self.objectStores.get(name);
        if (!s) throw new Error(`Store ${name} not found`);
        return s;
      },
    };
    // Store requests settle in a microtask, so completion has to come after
    // them or a caller waiting on `oncomplete` would see the work undone.
    queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
    return tx;
  }
}

const openDatabases = new Map<string, MockDatabase>();

export function setupMockIndexedDB() {
  openDatabases.clear();

  const mockIndexedDB = {
    open(name: string, version = 1) {
      const req = new MockRequest<MockDatabase>() as unknown as IDBOpenDBRequest;
      const existing = openDatabases.get(name);
      const isNew = !existing || existing.version < version;
      const db = existing || new MockDatabase(name, version);
      openDatabases.set(name, db);

      queueMicrotask(() => {
        if (isNew && (req as unknown as { onupgradeneeded?: () => void }).onupgradeneeded) {
          (req as unknown as { result: MockDatabase }).result = db;
          (req as unknown as { onupgradeneeded: () => void }).onupgradeneeded();
        }
        (req as unknown as MockRequest<MockDatabase>).succeed(db);
      });
      return req;
    },
    deleteDatabase(name: string) {
      const req = new MockRequest<void>();
      queueMicrotask(() => {
        openDatabases.delete(name);
        req.succeed(undefined);
      });
      return req;
    },
  };

  Object.defineProperty(globalThis, "indexedDB", {
    value: mockIndexedDB,
    writable: true,
    configurable: true,
  });
}

export function clearMockIndexedDB() {
  openDatabases.clear();
}
