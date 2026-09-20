import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA_VERSION = 4;

const MIGRATIONS: Record<number, string> = {
  1: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  local_canvas_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  video_session_id TEXT,
  last_propose_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(created_by, local_canvas_id)
);
CREATE TABLE members (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  last_opened_at TEXT,
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  room_id TEXT,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE entries (
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  author_id TEXT,
  data TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (room_id, seq),
  UNIQUE (room_id, id)
);
CREATE TABLE events (
  room_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  type TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (room_id, cursor)
);
CREATE TABLE tickets (
  hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  offered_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  lease_hash TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  entry_id TEXT,
  state_hash TEXT,
  status TEXT NOT NULL,
  output TEXT,
  trigger_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE idem (
  room_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (room_id, scope, request_id)
);
`,
  2: `
ALTER TABLE events ADD COLUMN data TEXT;
UPDATE events SET data=(SELECT entries.data FROM entries WHERE entries.room_id=events.room_id AND entries.id=events.entry_id);
CREATE TABLE asset_rooms (
  asset_id TEXT NOT NULL REFERENCES assets(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  PRIMARY KEY (asset_id, room_id)
);
INSERT INTO asset_rooms SELECT id, room_id FROM assets WHERE room_id IS NOT NULL;
CREATE TABLE pending_classification (
  room_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  PRIMARY KEY (room_id, entry_id)
);
`,
  3: `
ALTER TABLE rooms ADD COLUMN assistant_paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN context TEXT;
`,
  4: `
ALTER TABLE rooms ADD COLUMN assistant_eagerness TEXT NOT NULL DEFAULT 'eager';
`,
};

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const row = db.prepare("SELECT v FROM meta WHERE k='schema_version'").get() as { v: string } | undefined;
  const current = row ? Number(row.v) : 0;
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare("INSERT INTO meta (k,v) VALUES ('schema_version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(
        String(v),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
