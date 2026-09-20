import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { WebSocket } from "ws";
import {
  NodeSqliteWrapper,
  SQLiteSyncStorage,
  TLSocketRoom,
  type TLSyncForwardDiff,
  type TLRecordAuthorizer,
} from "@tldraw/sync-core";
import { type TLBaseShape, type TLShapeId } from "@tldraw/tlschema";
import { type UnknownRecord } from "@tldraw/store";
import { getIndexAbove, type IndexKey } from "@tldraw/utils";
import { createKanSchema, diagramPlacement, KAN_MAP_TYPE, KAN_NODE_TYPE, KAN_TABLE_TYPE, kanNodeSize, planDiagram } from "@kan/nodes";
import { type LiveTranscript, type TranscriptInput, type AssistantEagerness, AssistantResultSchema, CONTEXT_MAX_AGE_MS, CONTEXT_COOLDOWN_MS, DEFAULT_ASSISTANT_THRESHOLD, DEFAULT_EAGERNESS, eagernessPacing, EvidenceSourcesSchema, RegisterInput, SnapshotRecordSchema, shapeId as ShapeIdSchema, type AssistantResult, type Entry, type Lease, type Mutation, type NodeDraft, type Room, type RoomEvent, type Trigger } from "@kan/protocol";
import { generateRoomCode } from "./util";
import {
  EXPLICIT_TRIGGER,
  HUMAN_EDIT_DEBOUNCE_MS,
  PROACTIVE_COOLDOWN_MS,
  PROACTIVE_MAX_WAIT_MS,
  explicitMention,
  triggerDecision,
  type ClassificationState,
} from "./decision-policy";
import { queryDemoData } from "./demo-data";
import type { Classifier } from "./classifier";
import type { VideoProvider } from "./video";
import { badRequest, conflict, forbidden, notFound, unavailable, badGateway, unauthorized } from "./errors";
import { hashSecret, nowIso, randomToken, sha256, uuid, verifySecret } from "./util";
import { tx } from "./db";

export interface Timings {
  tickMs: number;
  offerMs: number;
  leaseMs: number;
  presenceTtlMs: number;
  debounceMs: number;
  classifyMaxWaitMs: number;
  cooldownMs: number;
  ticketTtlMs: number;
  roomIdleMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  tickMs: 1000,
  offerMs: 5000,
  leaseMs: 30_000,
  presenceTtlMs: 20_000,
  debounceMs: HUMAN_EDIT_DEBOUNCE_MS,
  classifyMaxWaitMs: PROACTIVE_MAX_WAIT_MS,
  cooldownMs: PROACTIVE_COOLDOWN_MS,
  ticketTtlMs: 30_000,
  roomIdleMs: 60_000,
};

export interface SessionInfo {
  sessionId: string;
  userId: string;
  ws: WebSocket | null;
  ready: boolean;
  agentId: string;
  busy: boolean;
  scope: "own" | "room" | "manual";
  background: boolean;
  lastSeen: number;
  transcript?: LiveTranscript;
  transcriptUpdatedAt?: number;
}

interface PendingEdit {
  userId: string;
  dueAt: number;
  added: Map<string, string>;
  changed: Set<string>;
  deleted: Set<string>;
}

interface RoomHandle {
  roomId: string;
  storage: SQLiteSyncStorage<UnknownRecord>;
  socketRoom: TLSocketRoom<UnknownRecord, { userId: string }>;
  sessions: Map<string, SessionInfo>;
  lastPushUserId: string | null;
  pendingEdits: Map<string, PendingEdit>;
  videoSessionPromise: Promise<string> | null;
  captionsPromise?: Promise<void>;
  captionsCheckedAt?: number;
  lastActivity: number;
}

const DOC_TYPE_NAMES = new Set(["document", "page", "shape", "binding", "asset"]);

/**
 * The records `validateGraph` is responsible for.
 *
 * tldraw's document scope is wider than the shape graph. `user` records are
 * document-scoped too, so once a room has collaborators in it — an online room
 * mints one per participant — the stored snapshot holds records the graph
 * rules know nothing about. The sync write path has always filtered them out
 * before validating; anything else that hands the stored snapshot to
 * `validateGraph` has to filter the same way, or every mutation in a shared
 * room is rejected as an "invalid record" that the room itself put there.
 */
function graphRecords(records: unknown[]): unknown[] {
  return records.filter((record) => DOC_TYPE_NAMES.has((record as { typeName?: string } | null)?.typeName ?? ""));
}
const ASSET_SRC_RE = /^\/assets\/([0-9a-f-]{36})$/;
const MAX_SEND_BUFFER = 8 * 1024 * 1024;

export interface EngineOptions {
  db: DatabaseSync;
  now?: () => number;
  timings?: Partial<Timings>;
  classifier?: Classifier | null;
  video?: VideoProvider | null;
  maxSendBuffer?: number;
}

export class Engine {
  readonly db: DatabaseSync;
  readonly timings: Timings;
  readonly classifier: Classifier | null;
  readonly video: VideoProvider | null;
  readonly maxSendBuffer: number;
  private readonly _now: () => number;
  private readonly schema = createKanSchema();
  private readonly rooms = new Map<string, RoomHandle>();
  private readonly classifierChains = new Map<string, Promise<void>>();
  private readonly pendingClassification = new Map<string, { cause: Entry; timer: ReturnType<typeof setTimeout>; deadlineAt: number; swept: boolean; promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void; previous: Promise<void> }>();
  private readonly lastAssigned = new Map<string, number>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private broadcastQueue: RoomEvent[] = [];
  private transactionDepth = 0;
  private stopping = false;

  private atomic<T>(fn: () => T): T {
    const mark = this.broadcastQueue.length;
    this.transactionDepth++;
    try { return fn(); } catch (error) {
      this.broadcastQueue.length = mark;
      throw error;
    } finally { this.transactionDepth--; }
  }

  private transaction<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    return this.atomic(() => tx(this.db, fn));
  }

  constructor(opts: EngineOptions) {
    this.db = opts.db;
    this._now = opts.now ?? Date.now;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.classifier = opts.classifier ?? null;
    this.video = opts.video ?? null;
    this.maxSendBuffer = opts.maxSendBuffer ?? MAX_SEND_BUFFER;
  }

  now() {
    return this._now();
  }

  start() {
    const pending = this.db.prepare("SELECT e.data FROM pending_classification p JOIN entries e ON e.room_id=p.room_id AND e.id=p.entry_id ORDER BY e.room_id,e.seq").all() as { data: string }[];
    for (const row of pending) { const cause = JSON.parse(row.data) as Entry; this.enqueueClassification(cause.roomId, cause); }
    if (this.timings.tickMs > 0 && !this.interval) {
      this.interval = setInterval(() => {
        try {
          this.tick();
        } catch {
          // scheduler errors must not kill the process
        }
      }, this.timings.tickMs);
      this.interval.unref?.();
    }
  }

  async stop() {
    this.stopping = true;
    await Promise.allSettled([...this.classifierChains.values(), ...[...this.rooms.values()].flatMap((h) => [h.videoSessionPromise, h.captionsPromise].filter((promise) => promise != null))]);
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const h of this.rooms.values()) {
      for (const s of h.sessions.values()) {
        try {
          s.ws?.close();
        } catch {}
      }
      try {
        h.socketRoom.close();
      } catch {}
    }
    this.rooms.clear();
  }

  // ---------- auth ----------

  registerUser(input: { userId: string; secret: string; name: string }) {
    const existing = this.db.prepare("SELECT id,name,secret_hash FROM users WHERE id=?").get(input.userId) as
      | { id: string; name: string; secret_hash: string }
      | undefined;
    if (existing) {
      if (!verifySecret(input.secret, existing.secret_hash)) throw conflict("user id already registered");
      return { user: { id: existing.id, name: existing.name }, created: false };
    }
    const at = nowIso(this.now());
    this.db
      .prepare("INSERT INTO users (id,name,secret_hash,created_at) VALUES (?,?,?,?)")
      .run(input.userId, input.name, hashSecret(input.secret), at);
    return { user: { id: input.userId, name: input.name }, created: true };
  }

  private verifiedCache = new Map<string, number>();

  authenticate(header: string | undefined | null): { id: string; name: string } {
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    const token = header.slice(7);
    const dot = token.indexOf(".");
    if (dot <= 0) throw unauthorized("malformed credential");
    const userId = token.slice(0, dot);
    const secret = token.slice(dot + 1);
    if (!RegisterInput.shape.userId.safeParse(userId).success || !RegisterInput.shape.secret.safeParse(secret).success) throw unauthorized("malformed credential");
    const cacheKey = sha256(token);
    const cached = this.verifiedCache.get(cacheKey);
    if (cached && cached > this.now()) {
      const u = this.db.prepare("SELECT id,name FROM users WHERE id=?").get(userId) as { id: string; name: string } | undefined;
      if (u) return u;
    }
    const row = this.db.prepare("SELECT id,name,secret_hash FROM users WHERE id=?").get(userId) as
      | { id: string; name: string; secret_hash: string }
      | undefined;
    if (!row || !verifySecret(secret, row.secret_hash)) throw unauthorized("invalid credential");
    if (this.verifiedCache.size > 5000) this.verifiedCache.clear();
    this.verifiedCache.set(cacheKey, this.now() + 60_000);
    return { id: row.id, name: row.name };
  }

  requireMember(roomId: string, userId: string) {
    const m = this.db.prepare("SELECT 1 FROM members WHERE room_id=? AND user_id=?").get(roomId, userId);
    if (!m) {
      const room = this.db.prepare("SELECT id FROM rooms WHERE id=?").get(roomId);
      if (!room) throw notFound("room not found");
      throw forbidden("not a member of this room");
    }
  }

  private getRoomRow(roomId: string) {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId) as Record<string, unknown> | undefined;
    if (!row) throw notFound("room not found");
    return row;
  }

  private rowToRoom(row: Record<string, unknown>): Room {
    return {
      id: row.id as string,
      localCanvasId: row.local_canvas_id as string,
      name: row.name as string,
      code: row.code as string,
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      assistantPaused: Boolean(row.assistant_paused),
      assistantEagerness: (row.assistant_eagerness as AssistantEagerness | null) ?? DEFAULT_EAGERNESS,
      assistantThreshold: Number(row.assistant_threshold ?? DEFAULT_ASSISTANT_THRESHOLD),
      assistantCooldownMs: Number(row.assistant_cooldown_ms ?? CONTEXT_COOLDOWN_MS),
    };
  }

  // ---------- entries & events ----------

  private nextSeq(roomId: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS s FROM entries WHERE room_id=?").get(roomId) as {
      s: number;
    };
    return r.s;
  }

  private nextCursor(roomId: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(cursor),0)+1 AS c FROM events WHERE room_id=?").get(roomId) as {
      c: number;
    };
    return r.c;
  }

  private insertEntry(roomId: string, entry: Entry): RoomEvent {
    const at = entry.at;
    this.db
      .prepare("INSERT INTO entries (room_id,seq,id,kind,author_id,data,at) VALUES (?,?,?,?,?,?,?)")
      .run(roomId, entry.seq, entry.id, entry.kind, entryAuthorId(entry), JSON.stringify(entry), at);
    return this.insertEvent(roomId, entry.id, at);
  }

  private insertEvent(roomId: string, entryId: string, at: string): RoomEvent {
    const cursor = this.nextCursor(roomId);
    const entry = this.getEntry(roomId, entryId)!;
    this.db
      .prepare("INSERT INTO events (room_id,cursor,type,entry_id,at,data) VALUES (?,?,?,?,?,?)")
      .run(roomId, cursor, "entry.upsert", entryId, at, JSON.stringify(entry));
    this.db.prepare("UPDATE rooms SET updated_at=? WHERE id=?").run(nowIso(this.now()), roomId);
    const event: RoomEvent = { cursor, roomId, at, type: "entry.upsert", entry };
    this.broadcastQueue.push(event);
    return event;
  }

  updateEntry(entry: Entry): RoomEvent {
    this.db
      .prepare("UPDATE entries SET data=?, at=? WHERE room_id=? AND id=?")
      .run(JSON.stringify(entry), entry.at, entry.roomId, entry.id);
    return this.insertEvent(entry.roomId, entry.id, entry.at);
  }

  getEntry(roomId: string, entryId: string): Entry | null {
    const row = this.db.prepare("SELECT data FROM entries WHERE room_id=? AND id=?").get(roomId, entryId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Entry) : null;
  }

  private flushBroadcasts() {
    if (this.transactionDepth) return;
    const events = this.broadcastQueue;
    this.broadcastQueue = [];
    for (const ev of events) {
      const handle = this.rooms.get(ev.roomId);
      if (!handle) continue;
      for (const s of handle.sessions.values()) {
        if (s.ws) this.sendSafe(s.ws, { type: "event", event: ev });
      }
    }
  }

  sendSafe(ws: WebSocket, msg: import("@kan/protocol").ServerMessage): boolean {
    try {
      if (ws.readyState !== ws.OPEN) return false;
      const data = JSON.stringify(msg);
      if (ws.bufferedAmount + Buffer.byteLength(data) > this.maxSendBuffer) {
        ws.close(1013, "reconnect from last received cursor");
        return false;
      }
      ws.send(data);
      return true;
    } catch { ws.close(1013, "transport unavailable"); return false; }
  }

  broadcastPresence(roomId: string) {
    const handle = this.rooms.get(roomId);
    if (!handle) return;
    const executors = [...handle.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      userId: s.userId,
      ready: s.ready,
      agentId: s.agentId,
      busy: s.busy,
      scope: s.scope,
      background: s.background,
    }));
    for (const s of handle.sessions.values()) {
      if (s.ws) this.sendSafe(s.ws, { type: "presence", ...this.roomDetail(roomId), executors });
    }
  }

  thread(roomId: string, afterSeq: number, limit: number) {
    const rows = this.db
      .prepare("SELECT data FROM entries WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?")
      .all(roomId, afterSeq, limit + 1) as { data: string }[];
    const hasMore = rows.length > limit;
    return { entries: rows.slice(0, limit).map((r) => JSON.parse(r.data) as Entry), hasMore };
  }

  eventsSince(roomId: string, since: number, limit: number, highwater?: number) {
    const current = (this.db.prepare("SELECT COALESCE(MAX(cursor),0) c FROM events WHERE room_id=?").get(roomId) as {
      c: number;
    }).c;
    if (!Number.isInteger(since) || since < 0 || since > current) {
      throw badRequest("invalid cursor: must be an integer between 0 and the current room cursor");
    }
    const rows = this.db
      .prepare(
        `SELECT cursor, at, data FROM events WHERE room_id=? AND cursor>? AND cursor<=? ORDER BY cursor LIMIT ?`,
      )
      .all(roomId, since, highwater ?? current, limit + 1) as { cursor: number; at: string; data: string }[];
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const events: RoomEvent[] = slice.map((r) => ({
      cursor: r.cursor,
      roomId,
      at: r.at,
      type: "entry.upsert",
      entry: JSON.parse(r.data) as Entry,
    }));
    return { events, nextCursor: slice.length ? slice[slice.length - 1].cursor : since, hasMore, currentCursor: current };
  }

  // ---------- rooms ----------

  publishRoom(
    user: { id: string; name: string },
    input: {
      localCanvasId: string;
      name: string;
      records?: unknown[];
      messages?: { id: string; text: string; at: string; anchors?: string[]; attachments?: string[]; source?: "typed" | "transcript"; replyToEntryId?: string }[];
      assetIds?: string[];
    },
  ): { room: Room; created: boolean } {
    const existing = this.db
      .prepare("SELECT * FROM rooms WHERE created_by=? AND local_canvas_id=?")
      .get(user.id, input.localCanvasId) as Record<string, unknown> | undefined;
    if (existing) return { room: this.rowToRoom(existing), created: false };

    const records = this.validateRecords(input.records ?? [], user.id, input.assetIds ?? []);
    if (!records.some((r) => (r as { typeName?: string }).typeName === "page")) records.push(defaultPageRecord());
    if (!records.some((r) => (r as { typeName?: string }).typeName === "document")) records.unshift(defaultDocumentRecord());
    this.validateGraph(records);
    const messageIds = new Set<string>();
    for (const m of input.messages ?? []) {
      if (messageIds.has(m.id)) throw badRequest("duplicate imported message id");
      messageIds.add(m.id);
    }

    for (const assetId of input.assetIds ?? []) {
      const a = this.db.prepare("SELECT owner_id FROM assets WHERE id=?").get(assetId) as { owner_id: string } | undefined;
      if (!a || a.owner_id !== user.id) throw badRequest(`asset ${assetId} is not an owned upload`);
    }
    for (const m of input.messages ?? []) {
      for (const assetId of m.attachments ?? []) {
        const a = this.db.prepare("SELECT owner_id FROM assets WHERE id=?").get(assetId) as
          | { owner_id: string }
          | undefined;
        if (!a || a.owner_id !== user.id) throw badRequest(`attachment ${assetId} is not an owned upload`);
      }
    }

    const roomId = uuid();
    const at = nowIso(this.now());
    const handle = this.getRoomHandle(roomId);

    const room: Room = {
      id: roomId,
      localCanvasId: input.localCanvasId,
      name: input.name,
      code: "",
      createdBy: user.id,
      createdAt: at,
      updatedAt: at,
      assistantPaused: false,
      assistantEagerness: DEFAULT_EAGERNESS,
      assistantThreshold: DEFAULT_ASSISTANT_THRESHOLD,
      assistantCooldownMs: CONTEXT_COOLDOWN_MS,
    };

    try {
      handle.storage.transaction((txn) => {
      // inside this callback the underlying SQLite transaction is open on the same db
      let code = "";
      for (let i = 0; i < 20; i++) {
        code = generateRoomCode();
        const clash = this.db.prepare("SELECT 1 FROM rooms WHERE code=?").get(code);
        if (!clash) break;
        if (i === 19) throw new Error("could not allocate room code");
      }
      room.code = code;
      this.db
        .prepare(
          "INSERT INTO rooms (id,local_canvas_id,name,code,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(roomId, input.localCanvasId, input.name, code, user.id, at, at);
      this.db
        .prepare("INSERT INTO members (room_id,user_id,joined_at,last_opened_at) VALUES (?,?,?,?)")
        .run(roomId, user.id, at, at);
      for (const assetId of input.assetIds ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO asset_rooms (room_id,asset_id) VALUES (?,?)").run(roomId, assetId);
      }
      let seq = 0;
      for (const m of input.messages ?? []) {
        for (const assetId of m.attachments ?? []) {
          this.db.prepare("INSERT OR IGNORE INTO asset_rooms (room_id,asset_id) VALUES (?,?)").run(roomId, assetId);
        }
        seq += 1;
        const entry: Entry = {
          id: m.id,
          roomId,
          seq,
          at: m.at,
          kind: "message",
          authorId: user.id,
          text: m.text,
          anchors: m.anchors ?? [],
          attachments: m.attachments ?? [],
          ...(m.source ? { source: m.source } : {}),
          ...(m.replyToEntryId ? { replyToEntryId: m.replyToEntryId } : {}),
        };
        this.insertEntry(roomId, entry);
      }
      for (const rec of records) {
        txn.set((rec as { id: string }).id, rec as UnknownRecord);
      }
      });
    } catch (error) {
      handle.socketRoom.close();
      this.rooms.delete(roomId);
      throw error;
    }
    this.flushBroadcasts();
    return { room, created: true };
  }

  private validateGraph(records: unknown[]) {
    if (records.length > 5000) throw badRequest("too many records");
    const map = new Map<string, Record<string, unknown>>();
    let documents = 0, pages = 0;
    for (const raw of records) {
      if (!SnapshotRecordSchema.safeParse(raw).success || !raw || typeof raw !== "object") throw badRequest("invalid bounded record");
      const rec = raw as Record<string, unknown>;
      const id = rec.id, type = rec.typeName;
      if (typeof id !== "string" || typeof type !== "string" || !DOC_TYPE_NAMES.has(type) || map.has(id)) throw badRequest("invalid or duplicate record");
      if (type === "shape" && !ShapeIdSchema.safeParse(id).success) throw badRequest("invalid shape id");
      try { this.schema.types[type as keyof typeof this.schema.types].validator.validate(rec); } catch { throw badRequest("record failed schema validation"); }
      const validateUrls = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (["url", "href", "src"].includes(key) && typeof child === "string" && child) {
            let protocol: string;
            try { protocol = new URL(child, "https://kan.invalid").protocol; } catch { throw badRequest("invalid URL"); }
            if (!["https:", "http:", "mailto:", "tel:"].includes(protocol)) throw badRequest("unsafe URL scheme");
          } else validateUrls(child);
        }
      };
      validateUrls(rec.props);
      map.set(id, rec);
      if (type === "document") documents++;
      if (type === "page") pages++;
    }
    if (documents !== 1 || pages < 1) throw badRequest("snapshot requires one document and at least one page");
    for (const rec of map.values()) {
      if (rec.typeName === "shape") {
        const visited = new Set([rec.id]);
        let parent = map.get(rec.parentId as string);
        while (parent?.typeName === "shape") {
          if (visited.has(parent.id)) throw badRequest("shape parent cycle");
          visited.add(parent.id);
          parent = map.get(parent.parentId as string);
        }
        if (parent?.typeName !== "page") throw badRequest("shape parent missing");
        if (rec.type === "image" || rec.type === "video") {
          const assetId = (rec.props as Record<string, unknown>).assetId;
          if (typeof assetId !== "string" || map.get(assetId)?.typeName !== "asset") throw badRequest("shape asset missing");
        }
      }
      if (rec.typeName === "binding" && (map.get(rec.fromId as string)?.typeName !== "shape" || map.get(rec.toId as string)?.typeName !== "shape")) throw badRequest("binding endpoint missing");
      if (rec.typeName === "asset") {
        const src = (rec.props as Record<string, unknown>).src;
        if (typeof src !== "string" || !ASSET_SRC_RE.test(src)) throw badRequest("invalid asset source");
      }
    }
  }

  private validateRecords(records: unknown[], userId: string, assetIds: string[]): unknown[] {
    const owned = new Set(assetIds);
    const out: unknown[] = [];
    for (const raw of records) {
      if (!raw || typeof raw !== "object") throw badRequest("record is not an object");
      const rec = raw as Record<string, unknown>;
      const typeName = rec.typeName;
      const id = rec.id;
      if (typeof typeName !== "string" || typeof id !== "string") throw badRequest("record missing typeName/id");
      if (!DOC_TYPE_NAMES.has(typeName)) {
        throw badRequest(`record type ${typeName} is not allowed in published snapshots`);
      }
      if (!id.startsWith(`${typeName}:`)) throw badRequest("record id does not match its typeName");
      if (typeName === "asset") {
        const props = rec.props as Record<string, unknown> | undefined;
        const src = props?.src;
        if (typeof src === "string" && src.length > 0) {
          const match = ASSET_SRC_RE.exec(src);
          if (!match || !owned.has(match[1])) {
            throw badRequest("asset records must reference owned uploads at /assets/<id>");
          }
        }
      }
      let validated: unknown;
      try {
        validated = (this.schema.types as Record<string, { validator: { validate(v: unknown): unknown } }>)[
          typeName
        ].validator.validate(rec);
      } catch {
        throw badRequest(`record ${id} failed schema validation`);
      }
      if (typeName === "shape") {
        validated = stripProvenance(validated as Record<string, unknown>);
      }
      out.push(validated);
    }
    return out;
  }

  roomDetail(roomId: string) {
    const row = this.getRoomRow(roomId);
    const members = this.db
      .prepare(
        "SELECT m.user_id AS id, u.name AS name, m.last_opened_at AS lastOpenedAt FROM members m JOIN users u ON u.id=m.user_id WHERE m.room_id=?",
      )
      .all(roomId) as { id: string; name: string; lastOpenedAt: string | null }[];
    return { room: this.rowToRoom(row), members: members.map((m) => ({ id: m.id, name: m.name })), };
  }

  joinRoom(userId: string, code: string) {
    const normalized = code.replace(/-/g, "").toUpperCase();
    if (!/^[0-9A-HJKMNP-TV-Z]{10}$/.test(normalized)) throw badRequest("invalid room code");
    const row = this.db.prepare("SELECT * FROM rooms WHERE code=?").get(normalized) as Record<string, unknown> | undefined;
    if (!row) throw notFound("no room for that code");
    this.db
      .prepare("INSERT INTO members (room_id,user_id,joined_at,last_opened_at) VALUES (?,?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET last_opened_at=excluded.last_opened_at")
      .run(row.id as string, userId, nowIso(this.now()), nowIso(this.now()));
    this.broadcastPresence(row.id as string);
    return { room: this.rowToRoom(row) };
  }

  /**
   * Leaving is per-member: the room, its canvas and its thread stay untouched
   * for everyone else. There is deliberately no room deletion — one member
   * tidying their catalog must not destroy work the others still rely on. A
   * room whose last member leaves simply stops being listed; rejoining by code
   * brings it back.
   */
  leaveRoom(user: { id: string; name: string }, roomId: string) {
    this.requireMember(roomId, user.id);
    const at = nowIso(this.now());
    this.transaction(() => {
      this.db.prepare("DELETE FROM members WHERE room_id=? AND user_id=?").run(roomId, user.id);
      const remaining = this.db.prepare("SELECT COUNT(*) AS n FROM members WHERE room_id=?").get(roomId) as { n: number };
      // Nobody is left to read it, and the entry would be the first thing a
      // rejoining member saw. Skip it rather than narrate an empty room.
      if (remaining.n === 0) return;
      const entry: Entry = {
        id: uuid(),
        roomId,
        seq: this.nextSeq(roomId),
        at,
        kind: "system",
        text: `${user.name} left the room`,
        authorId: user.id,
        shapeIds: [],
      };
      this.insertEntry(roomId, entry);
    });
    this.flushBroadcasts();
    this.broadcastPresence(roomId);
    return { ok: true };
  }

  renameUser(userId: string, name: string) {
    this.db.prepare("UPDATE users SET name=? WHERE id=?").run(name, userId);
    const rooms = this.db.prepare("SELECT room_id FROM members WHERE user_id=?").all(userId) as { room_id: string }[];
    for (const room of rooms) this.broadcastPresence(room.room_id);
  }

  listRooms(userId: string) {
    const rows = this.db
      .prepare(
        `SELECT r.*, m.last_opened_at AS lastOpenedAt FROM rooms r JOIN members m ON m.room_id=r.id WHERE m.user_id=? ORDER BY MAX(r.updated_at,COALESCE(m.last_opened_at,'')) DESC`,
      )
      .all(userId) as (Record<string, unknown> & { lastOpenedAt: string | null })[];
    return rows.map((r) => ({ ...this.rowToRoom(r), lastOpenedAt: r.lastOpenedAt }));
  }

  patchRoom(user: { id: string; name: string }, roomId: string, input: { name?: string; assistantPaused?: boolean; assistantEagerness?: AssistantEagerness; assistantThreshold?: number; assistantCooldownMs?: number }) {
    this.requireMember(roomId, user.id);
    const at = nowIso(this.now());
    const current = this.getRoomRow(roomId);
    const name = input.name ?? (current.name as string);
    const assistantPaused = input.assistantPaused ?? Boolean(current.assistant_paused);
    const eagerness = input.assistantEagerness ?? ((current.assistant_eagerness as AssistantEagerness | null) ?? DEFAULT_EAGERNESS);
    const threshold = input.assistantThreshold ?? Number(current.assistant_threshold);
    const cooldownMs = input.assistantCooldownMs ?? (input.assistantEagerness ? eagernessPacing(eagerness).cooldownMs : Number(current.assistant_cooldown_ms));
    this.transaction( () => {
      this.db.prepare("UPDATE rooms SET name=?, assistant_paused=?, assistant_eagerness=?, assistant_threshold=?, assistant_cooldown_ms=?, updated_at=? WHERE id=?").run(name, assistantPaused ? 1 : 0, eagerness, threshold, cooldownMs, at, roomId);
      // Only a rename is worth a thread entry. Pacing and pause are settings,
      // and a system entry here would itself be a classification cause.
      if (name !== current.name) {
        const entry: Entry = {
          id: uuid(),
          roomId,
          seq: this.nextSeq(roomId),
          at,
          kind: "system",
          text: `${user.name} renamed the room to "${name}"`,
          authorId: user.id,
          shapeIds: [],
        };
        this.insertEntry(roomId, entry);
      }
    });
    if (assistantPaused) this.cancelBackgroundWork(roomId);
    this.flushBroadcasts();
    this.broadcastPresence(roomId);
    return { room: this.rowToRoom(this.getRoomRow(roomId)) };
  }

  renameRoom(user: { id: string; name: string }, roomId: string, name: string) {
    return this.patchRoom(user, roomId, { name });
  }

  private cancelBackgroundWork(roomId: string) {
    const rows = this.db.prepare("SELECT id,data,entry_id,offered_ids FROM triggers WHERE room_id=? AND status IN ('pending','offered','running','needs_claim')").all(roomId) as { id: string; data: string; entry_id: string; offered_ids: string }[];
    for (const row of rows) {
      const trigger = JSON.parse(row.data) as Trigger;
      if (trigger.mode === "act") continue;
      let runningSessionId: string | null = null;
      this.transaction(() => {
        const run = trigger.runId ? this.db.prepare("SELECT session_id,run_id,entry_id FROM runs WHERE run_id=? AND status='running'").get(trigger.runId) as { session_id: string; run_id: string; entry_id: string } | undefined : undefined;
        runningSessionId = run?.session_id ?? null;
        if (run) this.db.prepare("UPDATE runs SET status='superseded' WHERE run_id=?").run(run.run_id);
        trigger.status = "cancelled";
        trigger.assigneeSessionId = null;
        trigger.offerExpiresAt = null;
        this.saveTriggerInTx(trigger, row);
        const entry = this.getEntry(roomId, run?.entry_id ?? row.entry_id);
        if (entry?.kind === "agent_turn" && entry.status === "running") {
          entry.status = "cancelled";
          entry.hidden = true;
          entry.at = nowIso(this.now());
          this.updateEntry(entry);
        }
      });
      if (runningSessionId) this.setBusy(roomId, runningSessionId, false);
    }
  }

  openRoom(userId: string, roomId: string) {
    this.requireMember(roomId, userId);
    this.db
      .prepare("UPDATE members SET last_opened_at=? WHERE room_id=? AND user_id=?")
      .run(nowIso(this.now()), roomId, userId);
    return { ok: true };
  }

  // ---------- assets ----------

  createAsset(userId: string, contentType: string, data: Buffer) {
    const id = uuid();
    this.db
      .prepare("INSERT INTO assets (id,owner_id,room_id,content_type,size,data,created_at) VALUES (?,?,NULL,?,?,?,?)")
      .run(id, userId, contentType, data.byteLength, data, nowIso(this.now()));
    return { id };
  }

  getAsset(assetId: string, userId: string) {
    const a = this.db.prepare("SELECT * FROM assets WHERE id=?").get(assetId) as
      | { owner_id: string; room_id: string | null; content_type: string; data: Buffer }
      | undefined;
    if (!a) throw notFound("asset not found");
    if (a.owner_id !== userId && !this.db.prepare("SELECT 1 FROM asset_rooms ar JOIN members m ON m.room_id=ar.room_id WHERE ar.asset_id=? AND m.user_id=?").get(assetId, userId)) throw forbidden("not allowed to read this asset");
    return a;
  }

  // ---------- messages ----------

  private isExplicitMessage(roomId: string, input: { text: string; source?: "typed" | "transcript"; replyToEntryId?: string }) {
    if (explicitMention(input.text, input.source ?? "typed")) return true;
    if (!input.replyToEntryId) return false;
    const target = this.getEntry(roomId, input.replyToEntryId);
    return target?.kind === "agent_turn" || target?.kind === "suggestion" || target?.kind === "offer";
  }

  postMessage(
    user: { id: string; name: string },
    roomId: string,
    input: { id: string; text: string; anchors?: string[]; attachments?: string[]; source?: "typed" | "transcript"; replyToEntryId?: string },
  ) {
    this.requireMember(roomId, user.id);
    const prior = this.db.prepare("SELECT data FROM entries WHERE room_id=? AND id=?").get(roomId, input.id) as
      | { data: string }
      | undefined;
    if (prior) {
      const e = JSON.parse(prior.data) as Entry;
      const same =
        e.kind === "message" &&
        e.authorId === user.id &&
        e.text === input.text &&
        JSON.stringify(e.anchors) === JSON.stringify(input.anchors ?? []) &&
        JSON.stringify(e.attachments) === JSON.stringify(input.attachments ?? []) &&
        e.source === input.source &&
        e.replyToEntryId === input.replyToEntryId;
      if (!same) throw conflict("message id already used with a different payload");
      return { entry: e, created: false };
    }
    for (const assetId of input.attachments ?? []) {
      const a = this.db.prepare("SELECT owner_id FROM assets WHERE id=?").get(assetId) as { owner_id: string } | undefined;
      if (!a || a.owner_id !== user.id) throw badRequest(`attachment ${assetId} is not an owned upload`);
    }
    const entry: Entry = {
      id: input.id,
      roomId,
      seq: 0,
      at: nowIso(this.now()),
      kind: "message",
      authorId: user.id,
      text: input.text,
      anchors: input.anchors ?? [],
      attachments: input.attachments ?? [],
      ...(input.source ? { source: input.source } : {}),
      ...(input.replyToEntryId ? { replyToEntryId: input.replyToEntryId } : {}),
    };
    const explicit = this.isExplicitMessage(roomId, input);
    let explicitTriggerId: string | null = null;
    this.transaction( () => {
      entry.seq = this.nextSeq(roomId);
      for (const assetId of input.attachments ?? []) {
        this.db.prepare("INSERT OR IGNORE INTO asset_rooms (room_id,asset_id) VALUES (?,?)").run(roomId, assetId);
      }
      this.insertEntry(roomId, entry);
      if (explicit) {
        const trigger = this.createTrigger(roomId, entry, EXPLICIT_TRIGGER, causeAnchors(entry));
        explicitTriggerId = trigger.id;
        this.recordDecision(roomId, entry, sha256(JSON.stringify(this.buildClassificationState(roomId, entry))), "explicit", null, trigger.id);
      } else {
        this.db.prepare("INSERT OR IGNORE INTO pending_classification (room_id,entry_id) VALUES (?,?)").run(roomId, entry.id);
      }
    });
    this.flushBroadcasts();
    if (explicit) {
      this.tick();
      console.info("room-server assistant_trigger", JSON.stringify({ roomId, entryId: entry.id, triggerId: explicitTriggerId, mode: "act", source: "explicit" }));
    } else {
      this.enqueueClassification(roomId, entry);
      console.info("room-server jev_queued", JSON.stringify({ roomId, entryId: entry.id, source: input.source ?? "typed", debounceMs: this.timings.debounceMs }));
    }
    return { entry, created: true };
  }

  // ---------- tickets ----------

  createTicket(userId: string, roomId: string, channel: "sync" | "events") {
    this.requireMember(roomId, userId);
    const ticket = randomToken(32);
    const expiresAt = this.now() + this.timings.ticketTtlMs;
    this.db
      .prepare("INSERT INTO tickets (hash,room_id,user_id,channel,expires_at,used) VALUES (?,?,?,?,?,0)")
      .run(sha256(ticket), roomId, userId, channel, expiresAt);
    return { ticket, expiresAt };
  }

  consumeTicket(roomId: string, channel: string, ticket: string): { userId: string } {
    const row = this.db.prepare("SELECT * FROM tickets WHERE hash=?").get(sha256(ticket)) as
      | { room_id: string; user_id: string; channel: string; expires_at: number; used: number }
      | undefined;
    if (!row) throw unauthorized("invalid ticket");
    if (row.room_id !== roomId || row.channel !== channel) throw unauthorized("ticket scope mismatch");
    if (row.used) throw unauthorized("ticket already used");
    if (row.expires_at <= this.now()) throw unauthorized("ticket expired");
    this.db.prepare("UPDATE tickets SET used=1 WHERE hash=?").run(sha256(ticket));
    return { userId: row.user_id };
  }

  // ---------- room handle / canvas ----------

  getRoomHandle(roomId: string): RoomHandle {
    const cached = this.rooms.get(roomId);
    if (cached) {
      cached.lastActivity = this.now();
      return cached;
    }
    const tablePrefix = `sync_${roomId.replace(/[^a-zA-Z0-9]/g, "_")}_`;
    const wrapper = new NodeSqliteWrapper(this.db as never, { tablePrefix });
    const storage = new SQLiteSyncStorage<UnknownRecord>({ sql: wrapper });
    const handle: RoomHandle = {
      roomId,
      storage,
      socketRoom: null as never,
      sessions: new Map(),
      lastPushUserId: null,
      pendingEdits: new Map(),
      videoSessionPromise: null,
      lastActivity: this.now(),
    };
    const authorizer: TLRecordAuthorizer<UnknownRecord, { userId: string }> = ({ session, type, next, prev }) => {
      handle.lastPushUserId = session.meta.userId;
      if (type === "create" && next) return stripProvenance(next as unknown as Record<string, unknown>) as unknown as UnknownRecord;
      if (type === "update" && next && prev) {
        const n = next as unknown as Record<string, unknown>;
        const p = prev as unknown as Record<string, unknown>;
        const nMeta = (n.meta ?? {}) as Record<string, unknown>;
        const pMeta = (p.meta ?? {}) as Record<string, unknown>;
        if (!isDeepStrictEqual(nMeta.provenance, pMeta.provenance)) return null;
        return next;
      }
      return next ?? prev;
    };
    const socketRoom = new TLSocketRoom<UnknownRecord, { userId: string }>({
      schema: this.schema,
      storage,
      log: {
        error: (...args) => console.error("room-server sync_error", ...args),
        warn: (...args) => console.warn("room-server sync_rejected", ...args),
      },
      authorizeRecord: {
        asset: ({ session, next, prev }: Parameters<TLRecordAuthorizer<UnknownRecord, { userId: string }>>[0]) => {
          if (!next) return prev;
          const src = ((next as unknown as { props?: { src?: unknown } }).props)?.src;
          const match = typeof src === "string" ? ASSET_SRC_RE.exec(src) : null;
          if (!match || !this.db.prepare("SELECT 1 FROM assets a WHERE a.id=? AND (a.owner_id=? OR EXISTS(SELECT 1 FROM asset_rooms ar WHERE ar.asset_id=a.id AND ar.room_id=?))").get(match[1], session.meta.userId, roomId)) return null;
          this.db.prepare("INSERT OR IGNORE INTO asset_rooms (asset_id,room_id) VALUES (?,?)").run(match[1], roomId);
          return next;
        },
        shape: authorizer,
        binding: (({ session, next, prev }: Parameters<TLRecordAuthorizer<UnknownRecord, { userId: string }>>[0]) => {
          handle.lastPushUserId = session.meta.userId;
          return next ?? prev;
        }),
      },
      onAfterReceiveMessage: () => { handle.lastPushUserId = null; },
      onCommittedChanges: ({ diff }) => this.onCanvasCommitted(handle, diff),
    });
    handle.socketRoom = socketRoom;
    const storageTransaction = storage.transaction.bind(storage);
    storage.transaction = (fn, options) => this.atomic(() => storageTransaction((txn) => {
      const result = fn(txn);
      const records = graphRecords([...txn.entries()].map(([, record]) => record));
      if (records.length || this.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomId)) this.validateGraph(records);
      return result;
    }, options));
    this.rooms.set(roomId, handle);
    return handle;
  }

  private onCanvasCommitted(handle: RoomHandle, diff: TLSyncForwardDiff<UnknownRecord>) {
    if (this.stopping) return;
    this.db.prepare("UPDATE rooms SET updated_at=? WHERE id=?").run(nowIso(this.now()), handle.roomId);
    const userId = handle.lastPushUserId;
    handle.lastPushUserId = null;
    if (!userId) return;
    let pending = handle.pendingEdits.get(userId);
    if (!pending) {
      pending = { userId, dueAt: 0, added: new Map(), changed: new Set(), deleted: new Set() };
      handle.pendingEdits.set(userId, pending);
    }
    pending.dueAt = this.now() + this.timings.debounceMs;
    for (const [id, put] of Object.entries(diff.puts)) {
      if (!id.startsWith("shape:") || (Array.isArray(put) && isDeepStrictEqual(put[0], put[1]))) continue;
      const after = Array.isArray(put) ? put[1] : put;
      if (Array.isArray(put)) {
        if (!pending.added.has(id)) pending.changed.add(id);
      } else {
        pending.changed.delete(id);
        pending.deleted.delete(id);
        pending.added.set(id, shapeLabel(after));
      }
    }
    for (const id of diff.deletes) {
      if (!id.startsWith("shape:")) continue;
      pending.added.delete(id);
      pending.changed.delete(id);
      pending.deleted.add(id);
    }
  }

  private flushPendingEdits(roomId: string) {
    const handle = this.rooms.get(roomId);
    if (!handle) return;
    const now = this.now();
    for (const [userId, pending] of [...handle.pendingEdits]) {
      if (pending.dueAt > now) continue;
      handle.pendingEdits.delete(userId);
      const user = this.db.prepare("SELECT name FROM users WHERE id=?").get(userId) as { name: string } | undefined;
      const parts: string[] = [];
      for (const [id, label] of [...pending.added].slice(0, 8)) parts.push(`added ${label ? `'${label}' ` : ""}(${id})`);
      for (const id of [...pending.changed].slice(0, 8)) parts.push(`changed ${id}`);
      if (pending.deleted.size) parts.push(`deleted ${pending.deleted.size === 1 ? [...pending.deleted][0] : `${pending.deleted.size} items`}`);
      if (!parts.length) continue;
      const entry: Entry = {
        id: uuid(),
        roomId,
        seq: 0,
        at: nowIso(now),
        kind: "system",
        text: `${user?.name ?? "A participant"} edited the canvas: ${parts.join(", ")}`.slice(0, 2000),
        authorId: userId,
        shapeIds: [...pending.added.keys(), ...pending.changed, ...pending.deleted].slice(0, 200),
      };
      this.transaction( () => {
        entry.seq = this.nextSeq(roomId);
        this.insertEntry(roomId, entry);
        this.db.prepare("INSERT OR IGNORE INTO pending_classification (room_id,entry_id) VALUES (?,?)").run(roomId, entry.id);
      });
      this.flushBroadcasts();
      this.enqueueClassification(roomId, entry);
    }
  }

  canvasRecords(roomId: string): unknown[] {
    const handle = this.getRoomHandle(roomId);
    return handle.storage.getSnapshot().documents.map((d) => d.state);
  }

  canvasSummary(roomId: string) {
    const records = this.canvasRecords(roomId);
    const shapes = records.filter((r) => (r as { typeName?: string }).typeName === "shape") as TLBaseShape<
      string,
      Record<string, unknown>
    >[];
    shapes.sort((a, b) => a.id.localeCompare(b.id));
    const bounded = shapes.slice(0, 500).map((s) => ({
      id: s.id,
      type: s.type,
      label: shapeLabel(s),
      x: s.x,
      y: s.y,
      parentId: s.parentId,
    }));
    return { shapes: bounded, counts: { shapes: shapes.length, records: records.length } };
  }

  // ---------- classification ----------

  // How long to keep deferring the pending cause. Each new cause restarts the
  // settle timer, but never past the batch's deadline, so a room that keeps
  // talking is still checked every classifyMaxWaitMs instead of never.
  private classificationDelay(deadlineAt: number) {
    return Math.max(0, Math.min(this.timings.debounceMs, deadlineAt - this.now()));
  }

  /** True when the deadline, not a silence, is what will release the cause. */
  private sweeping(deadlineAt: number) {
    return deadlineAt - this.now() < this.timings.debounceMs;
  }

  enqueueClassification(roomId: string, cause: Entry) {
    const pending = this.pendingClassification.get(roomId);
    if (pending) { pending.cause = cause; pending.swept = this.sweeping(pending.deadlineAt); clearTimeout(pending.timer); pending.timer = setTimeout(() => this.flushClassification(roomId), this.classificationDelay(pending.deadlineAt)); return; }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const previous = this.classifierChains.get(roomId) ?? Promise.resolve();
    const maxWaitMs = this.pacing(roomId).maxWaitMs;
    const deadlineAt = maxWaitMs > 0 ? this.now() + maxWaitMs : Number.POSITIVE_INFINITY;
    const timer = setTimeout(() => this.flushClassification(roomId), this.classificationDelay(deadlineAt));
    this.pendingClassification.set(roomId, { cause, timer, deadlineAt, swept: this.sweeping(deadlineAt), promise, resolve, reject, previous });
    this.classifierChains.set(roomId, promise);
    void promise.catch(() => console.error("room-server classification_persistence_error"));
  }

  private flushClassification(roomId: string) {
    const pending = this.pendingClassification.get(roomId);
    if (!pending) return;
    this.pendingClassification.delete(roomId);
    // A persistence failure has to reach whoever is awaiting this room's
    // classification, but it must not poison the chain: the next cause still
    // runs, which is what lets a restart drain the durable pending queue.
    void pending.previous.catch(() => {}).then(() => this.processCause(roomId, pending.cause, pending.swept)).then(pending.resolve, pending.reject);
  }

  classifierIdle(roomId: string): Promise<void> {
    return this.classifierChains.get(roomId) ?? Promise.resolve();
  }

  private async processCause(roomId: string, cause: Entry, swept = false) {
    if (this.stopping || (cause.kind !== "message" && cause.kind !== "system")) return;
    if (!this.db.prepare("SELECT 1 FROM pending_classification WHERE room_id=? AND entry_id=?").get(roomId, cause.id)) return;
    const state = this.buildClassificationState(roomId, cause);
    const stateHash = sha256(JSON.stringify(state));
    const evaluationStartedAt = Date.now();
    const roomRow = this.getRoomRow(roomId);
    let triggerThreshold = Number(roomRow.assistant_threshold);
    let cooldownMs = Number(roomRow.assistant_cooldown_ms);
    const explicit = cause.kind === "message" && explicitMention(cause.text, cause.source ?? "typed");
    let output: unknown = null;
    let status = explicit ? "explicit" : this.classifier ? "evaluated" : "skipped";
    let plan = explicit ? EXPLICIT_TRIGGER : null as ReturnType<typeof triggerDecision>;
    const anchors = [...causeAnchors(cause)];
    if (!explicit && this.classifier) {
      try {
        const decision = await this.classifier.decide(state);
        const currentSettings = this.getRoomRow(roomId);
        triggerThreshold = Number(currentSettings.assistant_threshold);
        cooldownMs = Number(currentSettings.assistant_cooldown_ms);
        output = { ...decision, triggerThreshold };
        plan = triggerDecision(decision, triggerThreshold, cause.kind === "message" && cause.source === "transcript" ? "act" : "context");
      } catch {
        status = "failed";
        output = { error: "classifier_unavailable" };
      }
      // A cause the room has already moved past is normally dropped. A swept
      // check is deliberately the busy case — the room was still talking when
      // the deadline fired — so newer entries are expected and only re-anchor
      // the decision. The assistant policy still tells it to stay silent when
      // the subject has genuinely moved on.
      const latest = this.db.prepare("SELECT MAX(seq) AS seq FROM entries WHERE room_id=? AND seq>? AND kind IN ('message','system')").get(roomId, cause.seq) as { seq: number | null };
      if (latest.seq !== null) {
        if (swept) {
          status = "swept";
        } else {
          plan = null;
          status = "stale";
        }
      }
    }
    if (this.stopping) return;
    let triggerId: string | null = null;
    let suppression: "below_threshold" | "cooldown" | "paused" | "stale" | "classifier_error" | null = null;
    this.transaction(() => {
      const currentRoom = this.getRoomRow(roomId);
      const paused = Boolean(currentRoom.assistant_paused);
      const cooldownActive = plan?.mode !== "act" ? this.inCooldown(roomId) : false;
      if (plan && !(plan.mode !== "act" && (cooldownActive || paused))) {
        triggerId = this.createTrigger(roomId, cause, plan, anchors.slice(0, 64)).id;
        if (plan.mode !== "act") this.db.prepare("UPDATE rooms SET last_propose_at=? WHERE id=?").run(this.now(), roomId);
      } else if (plan) {
        suppression = paused ? "paused" : "cooldown";
      } else if (status === "failed") {
        suppression = "classifier_error";
      } else if (status === "stale") {
        suppression = "stale";
      } else if (!explicit && status === "evaluated") {
        suppression = "below_threshold";
      }
      this.recordDecision(roomId, cause, stateHash, status, output, triggerId);
      this.db.prepare("DELETE FROM pending_classification WHERE room_id=? AND entry_id=?").run(roomId, cause.id);
    });
    this.flushBroadcasts();
    this.tick();
    const trigger = triggerId ? this.listTriggers(roomId).find((candidate) => candidate.id === triggerId) : undefined;
    const triggerProbability = output && typeof output === "object" && "triggerProbability" in output ? (output as { triggerProbability?: unknown }).triggerProbability : null;
    console.info("room-server jev_decision", JSON.stringify({
      roomId,
      entryId: cause.id,
      causeKind: cause.kind,
      status,
      swept,
      durationMs: Date.now() - evaluationStartedAt,
      triggerProbability,
      triggerThreshold,
      cooldownMs,
      suppression,
      triggerId,
      triggerStatus: trigger?.status ?? null,
    }));
  }

  // The room's own pacing, falling back to the server defaults for a room that
  // is not in the database yet (a local canvas classifying before it is shared).
  private pacing(roomId: string) {
    const row = this.db.prepare("SELECT assistant_eagerness,assistant_cooldown_ms FROM rooms WHERE id=?").get(roomId) as { assistant_eagerness: string | null; assistant_cooldown_ms: number } | undefined;
    if (!row) return { maxWaitMs: this.timings.classifyMaxWaitMs, cooldownMs: this.timings.cooldownMs };
    const preset = eagernessPacing(row.assistant_eagerness);
    return { maxWaitMs: preset.maxWaitMs, cooldownMs: row.assistant_cooldown_ms };
  }

  private inCooldown(roomId: string): boolean {
    const row = this.db.prepare("SELECT last_propose_at FROM rooms WHERE id=?").get(roomId) as
      | { last_propose_at: number }
      | undefined;
    return !!row && row.last_propose_at > 0 && this.now() - row.last_propose_at < this.pacing(roomId).cooldownMs;
  }

  private recordDecision(roomId: string, cause: Entry, stateHash: string, status: string, output: unknown, triggerId: string | null) {
    this.db.prepare("INSERT INTO decisions (id,room_id,entry_id,state_hash,status,output,trigger_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(uuid(), roomId, cause.id, stateHash, status, output ? JSON.stringify(output) : null, triggerId, nowIso(this.now()));
  }

  private buildClassificationState(roomId: string, cause: Entry): ClassificationState {
    const recent = this.db
      .prepare("SELECT data FROM entries WHERE room_id=? ORDER BY seq DESC LIMIT 10")
      .all(roomId) as { data: string }[];
    const recentEntries = recent.map((r) => JSON.parse(r.data)).reverse();
    const summary = this.canvasSummary(roomId);
    const records = this.canvasRecords(roomId);
    const shapeById = new Map(records.filter((r) => (r as { typeName?: string }).typeName === "shape").map((r) => [(r as { id: string }).id, r]));
    const shapes = summary.shapes.slice(0, 50).map((s) => ({ id: s.id, label: (s.label ?? "").slice(0, 240), type: s.type, props: boundedContextProps((shapeById.get(s.id) as { props?: unknown } | undefined)?.props) }));
    const openSuggestions = this.db
      .prepare("SELECT data FROM entries WHERE room_id=? AND kind IN ('suggestion','offer') AND json_extract(data,'$.status')='open' ORDER BY seq DESC LIMIT 20")
      .all(roomId)
      .map((r) => JSON.parse((r as { data: string }).data));
    const recentResolvedContributions = this.db
      .prepare("SELECT data FROM entries WHERE room_id=? AND kind IN ('suggestion','offer') AND json_extract(data,'$.status')!='open' ORDER BY seq DESC LIMIT 20")
      .all(roomId)
      .map((r) => JSON.parse((r as { data: string }).data));
    const state: ClassificationState = {
      cause: {
        id: cause.id,
        kind: cause.kind as "message" | "system",
        text: cause.kind === "message" || cause.kind === "system" ? cause.text : "",
        authorId: entryAuthorId(cause) ?? "",
      },
      recentEntries,
      shapes,
      openSuggestions,
      recentResolvedContributions,
    };
    return state;
  }

  private createTrigger(
    roomId: string,
    cause: Entry,
    plan: { mode: "act" | "propose" | "context"; intent: "answer" | "capture" | "update" | "lookup" | "evidence" | "align"; confidence: number; reason: string },
    anchors?: string[],
    source: "explicit" | "context" | "accepted" = plan.mode === "act" ? "explicit" : "context",
    requestedBy?: string,
    approval?: { causeEntryIds?: string[]; approvedRequest?: string; acceptedOfferId?: string },
    deferBroadcast = false,
  ): Trigger {
    const at = nowIso(this.now());
    const trigger: Trigger = {
      id: uuid(),
      causeEntryIds: approval?.causeEntryIds ?? [cause.id],
      requestedBy: requestedBy ?? entryAuthorId(cause) ?? "",
      reason: plan.reason.slice(0, 1000),
      intent: plan.intent,
      mode: plan.mode,
      anchors: anchors ?? causeAnchors(cause),
      confidence: plan.confidence,
      status: "pending",
      assigneeSessionId: null,
      offerExpiresAt: null,
      attempt: 0,
      runId: null,
      source,
      createdAt: this.now(),
      ...(approval?.approvedRequest ? { approvedRequest: approval.approvedRequest } : {}),
      ...(approval?.acceptedOfferId ? { acceptedOfferId: approval.acceptedOfferId } : {}),
    };
    const entry: Entry = { id: uuid(), roomId, seq: 0, at, kind: "trigger", trigger };
    this.transaction( () => {
      entry.seq = this.nextSeq(roomId);
      this.insertEntry(roomId, entry);
      this.db
        .prepare("INSERT INTO triggers (id,room_id,entry_id,status,data,offered_ids,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(trigger.id, roomId, entry.id, "pending", JSON.stringify(trigger), "[]", at);
    });
    if (!deferBroadcast) {
      this.flushBroadcasts();
      if (!this.transactionDepth) this.tick();
    }
    return trigger;
  }

  private loadTrigger(triggerId: string): { trigger: Trigger; row: { room_id: string; entry_id: string; offered_ids: string } } {
    const row = this.db.prepare("SELECT * FROM triggers WHERE id=?").get(triggerId) as
      | { room_id: string; entry_id: string; data: string; offered_ids: string }
      | undefined;
    if (!row) throw notFound("trigger not found");
    return { trigger: JSON.parse(row.data) as Trigger, row };
  }

  listTriggers(roomId: string): Trigger[] {
    const rows = this.db.prepare("SELECT data FROM triggers WHERE room_id=? ORDER BY created_at").all(roomId) as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as Trigger);
  }

  // ---------- presence / sessions ----------

  addSession(roomId: string, userId: string, ws: WebSocket): SessionInfo {
    const handle = this.getRoomHandle(roomId);
    const session: SessionInfo = {
      sessionId: `sess_${uuid()}`,
      userId,
      ws,
      ready: false,
      agentId: "",
      busy: false,
      scope: "own",
      background: false,
      lastSeen: this.now(),
    };
    handle.sessions.set(session.sessionId, session);
    return session;
  }

  removeSession(roomId: string, sessionId: string) {
    const handle = this.rooms.get(roomId);
    if (!handle) return;
    const session = handle.sessions.get(sessionId);
    if (!session) return;
    this.clearTranscript(roomId, sessionId);
    handle.sessions.delete(sessionId);
    session.ws?.close(1001, "session ended");
    // release any non-expired offer held by this session
    const rows = this.db
      .prepare("SELECT id,data,entry_id,offered_ids FROM triggers WHERE room_id=? AND status='offered'")
      .all(roomId) as { id: string; data: string; entry_id: string; offered_ids: string }[];
    for (const row of rows) {
      const t = JSON.parse(row.data) as Trigger;
      if (t.assigneeSessionId === sessionId) this.reofferOrEscalate(roomId, t, row, sessionId);
    }
    this.flushBroadcasts();
    this.broadcastPresence(roomId);
  }

  setExecutorReady(roomId: string, sessionId: string, ready: boolean, agentId: string, scope: "own" | "room" | "manual" = "own", background = false) {
    const handle = this.rooms.get(roomId);
    const session = handle?.sessions.get(sessionId);
    if (!session) return;
    session.ready = ready;
    session.scope = scope;
    session.background = background;
    if (agentId) session.agentId = agentId;
    session.lastSeen = this.now();
    const offers = this.db.prepare("SELECT id,data,entry_id,offered_ids FROM triggers WHERE room_id=? AND status='offered' AND json_extract(data,'$.assigneeSessionId')=?").all(roomId, sessionId) as { id: string; data: string; entry_id: string; offered_ids: string }[];
    for (const offer of offers) {
      const trigger = JSON.parse(offer.data) as Trigger;
      const compatible = trigger.mode === "act" ? scope !== "manual" && (scope === "room" || trigger.requestedBy === session.userId) : (trigger.mode === "context" || trigger.mode === "propose") && scope === "room" && background;
      if (!ready || !compatible) this.reofferOrEscalate(roomId, trigger, offer, sessionId);
    }
    this.broadcastPresence(roomId);
  }

  clearTranscript(roomId: string, sessionId: string) {
    const handle = this.rooms.get(roomId), session = handle?.sessions.get(sessionId);
    if (!handle || !session?.transcript) return;
    session.transcript = undefined;
    for (const peer of handle.sessions.values()) if (peer.ws) this.sendSafe(peer.ws, { type: "transcript", sessionId, caption: null });
  }

  receiveTranscript(roomId: string, sessionId: string, input: TranscriptInput) {
    const handle = this.rooms.get(roomId), session = handle?.sessions.get(sessionId);
    if (!handle || !session?.ws) return;
    if ([...handle.sessions.values()].some((peer) => peer !== session && peer.transcript?.id === input.id)) throw conflict("caption id already used");
    if (input.isFinal) {
      this.postMessage({ id: session.userId, name: "" }, roomId, { id: input.id, text: input.text, source: "transcript" });
      if (session.transcript?.id === input.id) this.clearTranscript(roomId, sessionId);
      this.sendSafe(session.ws, { type: "transcript.ack", id: input.id });
      return;
    }
    if (this.getEntry(roomId, input.id)) return;
    if (session.transcriptUpdatedAt !== undefined && this.now() - session.transcriptUpdatedAt < 50) return;
    const caption = { id: input.id, text: input.text, authorId: session.userId, at: session.transcript?.id === input.id ? session.transcript.at : nowIso(this.now()), sessionId };
    session.transcript = caption;
    session.transcriptUpdatedAt = this.now();
    for (const peer of handle.sessions.values()) if (peer.ws) this.sendSafe(peer.ws, { type: "transcript", sessionId, caption });
  }

  heartbeatSession(roomId: string, sessionId: string) {
    const session = this.rooms.get(roomId)?.sessions.get(sessionId);
    if (session) session.lastSeen = this.now();
  }

  // ---------- scheduler ----------

  tick() {
    if (this.stopping) return;
    const now = this.now();
    this.db.prepare("DELETE FROM tickets WHERE expires_at<=?").run(now);
    // presence expiry + debounce flush + room idle eviction
    for (const [roomId, handle] of [...this.rooms]) {
      let presenceChanged = false;
      for (const [sid, s] of [...handle.sessions]) {
        if (now - s.lastSeen >= this.timings.presenceTtlMs) {
          this.removeSession(roomId, sid);
          presenceChanged = true;
        }
      }
      if (presenceChanged) this.broadcastPresence(roomId);
      this.flushPendingEdits(roomId);
      const clients =
        handle.sessions.size + ((handle.socketRoom as unknown as { getNumActiveSessions?: () => number }).getNumActiveSessions?.() ?? 0);
      for (const session of handle.sessions.values()) {
        if (session.transcript && now - (session.transcriptUpdatedAt ?? 0) > 15_000) this.clearTranscript(roomId, session.sessionId);
      }
      if (clients === 0 && !handle.videoSessionPromise && !handle.captionsPromise && now - handle.lastActivity > this.timings.roomIdleMs) {
        try {
          handle.socketRoom.close();
        } catch {}
        this.rooms.delete(roomId);
      }
    }

    // expire running leases
    const staleRuns = this.db
      .prepare("SELECT * FROM runs WHERE status='running' AND lease_expires_at<=?")
      .all(now) as { run_id: string; room_id: string; trigger_id: string; entry_id: string; session_id: string }[];
    for (const run of staleRuns) {
      this.transaction( () => {
        this.db.prepare("UPDATE runs SET status='expired' WHERE run_id=?").run(run.run_id);
        const { trigger, row } = this.loadTrigger(run.trigger_id);
        if (trigger.runId === run.run_id) {
          trigger.status = "expired";
          this.saveTriggerInTx(trigger, row);
        }
        const entry = this.getEntry(run.room_id, run.entry_id);
        if (entry && entry.kind === "agent_turn" && entry.status === "running") {
          entry.status = "failed";
          entry.at = nowIso(now);
          this.updateEntry(entry);
        }
      });
      this.setBusy(run.room_id, run.session_id, false);
    }
    this.flushBroadcasts();

    // expire offers
    const expiredOffers = this.db
      .prepare("SELECT id,room_id,entry_id,data,offered_ids FROM triggers WHERE status='offered'")
      .all() as { id: string; room_id: string; entry_id: string; data: string; offered_ids: string }[];
    for (const row of expiredOffers) {
      const t = JSON.parse(row.data) as Trigger;
      if (t.offerExpiresAt !== null && t.offerExpiresAt <= now) {
        this.reofferOrEscalate(row.room_id, t, row, t.assigneeSessionId);
      }
    }
    this.flushBroadcasts();

    // offer pending / needs_claim triggers
    const pendingRows = this.db
      .prepare("SELECT id,room_id,entry_id,data,offered_ids FROM triggers WHERE status IN ('pending','needs_claim') ORDER BY CASE json_extract(data,'$.mode') WHEN 'act' THEN 0 ELSE 1 END, created_at")
      .all() as { id: string; room_id: string; entry_id: string; data: string; offered_ids: string }[];
    const runningRooms = new Set(
      (this.db.prepare("SELECT room_id FROM triggers WHERE status='running'").all() as { room_id: string }[]).map(
        (r) => r.room_id,
      ),
    );
    const offeredRooms = new Set(
      (this.db.prepare("SELECT room_id FROM triggers WHERE status='offered'").all() as { room_id: string }[]).map(
        (r) => r.room_id,
      ),
    );
    for (const row of pendingRows) {
      if (runningRooms.has(row.room_id) || offeredRooms.has(row.room_id)) continue;
      const t = JSON.parse(row.data) as Trigger;
      const offeredIds = JSON.parse(row.offered_ids) as string[];
      const roomRow = this.getRoomRow(row.room_id);
      if ((t.mode === "context" || t.mode === "propose") && Boolean(roomRow.assistant_paused)) continue;
      if ((t.mode === "context" || t.mode === "propose") && t.createdAt !== undefined && now - t.createdAt > CONTEXT_MAX_AGE_MS) {
        t.status = "expired";
        this.saveTriggerAndBroadcast(t, row, offeredIds);
        continue;
      }
      const candidate = this.pickCandidate(row.room_id, t, offeredIds);
      if (candidate) {
        t.status = "offered";
        t.assigneeSessionId = candidate.sessionId;
        t.offerExpiresAt = now + this.timings.offerMs;
        offeredIds.push(candidate.sessionId);
        this.lastAssigned.set(candidate.sessionId, now);
        this.saveTriggerAndBroadcast(t, row, offeredIds);
        offeredRooms.add(row.room_id);
        console.info("room-server assistant_trigger_offered", JSON.stringify({ roomId: row.room_id, triggerId: t.id, mode: t.mode, sessionId: candidate.sessionId, scope: candidate.scope, background: candidate.background }));
      } else if (t.status === "pending") {
        t.status = "needs_claim";
        this.saveTriggerAndBroadcast(t, row, offeredIds);
        console.info("room-server assistant_trigger_needs_claim", JSON.stringify({ roomId: row.room_id, triggerId: t.id, mode: t.mode, reason: "no_eligible_executor" }));
      }
    }
    this.flushBroadcasts();
  }

  private saveTriggerInTx(trigger: Trigger, row: { entry_id: string; offered_ids: string }, offeredIds?: string[]) {
    this.db
      .prepare("UPDATE triggers SET status=?, data=?, offered_ids=? WHERE id=?")
      .run(trigger.status, JSON.stringify(trigger), JSON.stringify(offeredIds ?? JSON.parse(row.offered_ids)), trigger.id);
    const roomId = (this.db.prepare("SELECT room_id FROM triggers WHERE id=?").get(trigger.id) as { room_id: string })
      .room_id;
    const entry = this.getEntry(roomId, row.entry_id);
    if (entry && entry.kind === "trigger") {
      entry.trigger = trigger;
      entry.at = nowIso(this.now());
      this.updateEntry(entry);
    }
  }

  private saveTriggerAndBroadcast(trigger: Trigger, row: { room_id: string; entry_id: string; offered_ids: string }, offeredIds: string[]) {
    this.transaction( () => this.saveTriggerInTx(trigger, row, offeredIds));
    this.flushBroadcasts();
  }

  private pickCandidate(roomId: string, trigger: Trigger, exclude: string[]): SessionInfo | null {
    const handle = this.rooms.get(roomId);
    if (!handle) return null;
    const candidates = [...handle.sessions.values()].filter((s) => {
      if (!s.ready || s.busy || exclude.includes(s.sessionId) || this.now() - s.lastSeen >= this.timings.presenceTtlMs) return false;
      if (trigger.mode === "act") return s.scope !== "manual" && (s.scope === "room" || s.userId === trigger.requestedBy);
      if (trigger.mode === "context" || trigger.mode === "propose") return s.scope === "room" && s.background;
      return false;
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const aReq = a.userId === trigger.requestedBy ? 0 : 1;
      const bReq = b.userId === trigger.requestedBy ? 0 : 1;
      if (aReq !== bReq) return aReq - bReq;
      return (this.lastAssigned.get(a.sessionId) ?? 0) - (this.lastAssigned.get(b.sessionId) ?? 0);
    });
    return candidates[0];
  }

  private reofferOrEscalate(roomId: string, t: Trigger, row: { entry_id: string; offered_ids: string }, lostSessionId: string | null) {
    const offeredIds = JSON.parse(row.offered_ids) as string[];
    if (lostSessionId && !offeredIds.includes(lostSessionId)) offeredIds.push(lostSessionId);
    const candidate = this.pickCandidate(roomId, t, offeredIds);
    if (candidate) {
      t.status = "offered";
      t.assigneeSessionId = candidate.sessionId;
      t.offerExpiresAt = this.now() + this.timings.offerMs;
      offeredIds.push(candidate.sessionId);
      this.lastAssigned.set(candidate.sessionId, this.now());
    } else {
      t.status = "needs_claim";
      t.assigneeSessionId = null;
      t.offerExpiresAt = null;
    }
    this.transaction( () => this.saveTriggerInTx(t, row, offeredIds));
  }

  private setBusy(roomId: string, sessionId: string, busy: boolean) {
    const s = this.rooms.get(roomId)?.sessions.get(sessionId);
    if (s) {
      s.busy = busy;
      this.broadcastPresence(roomId);
    }
  }

  // ---------- claim / runs ----------

  claimTrigger(userId: string, roomId: string, triggerId: string, input: { sessionId: string; manual?: boolean }): Lease {
    this.requireMember(roomId, userId);
    const handle = this.rooms.get(roomId);
    const session = handle?.sessions.get(input.sessionId);
    if (!session || session.userId !== userId) throw forbidden("session does not belong to you");
    if (!session.ready || this.now() - session.lastSeen >= this.timings.presenceTtlMs) {
      throw conflict("session is not a ready executor");
    }
    const { trigger, row } = this.loadTrigger(triggerId);
    if (row.room_id !== roomId) throw notFound("trigger not found");
    const offeredIds = JSON.parse(row.offered_ids) as string[];
    const now = this.now();
    if ((trigger.mode === "context" || trigger.mode === "propose") && Boolean(this.getRoomRow(roomId).assistant_paused)) throw forbidden("contextual assistance is paused");
    const allowed =
      (trigger.status === "offered" &&
        trigger.assigneeSessionId === session.sessionId &&
        trigger.offerExpiresAt !== null &&
        trigger.offerExpiresAt > now) ||
      (trigger.status === "needs_claim" && input.manual === true) ||
      (trigger.status === "pending" && userId === trigger.requestedBy);
    if (!allowed) {
      if (trigger.status === "offered" || trigger.status === "running") throw conflict("trigger already assigned");
      throw conflict("trigger is not claimable");
    }
    const running = this.db
      .prepare("SELECT 1 FROM triggers WHERE room_id=? AND status='running'")
      .get(roomId);
    if (running) throw conflict("another run is already active in this room");

    const runId = uuid();
    const leaseToken = randomToken(32);
    const attempt = trigger.attempt + 1;
    const expiresAt = now + this.timings.leaseMs;
    const agentEntry: Entry = {
      id: uuid(),
      roomId,
      seq: 0,
      at: nowIso(now),
      kind: "agent_turn",
      triggerId,
      runId,
      byUserId: userId,
      agentId: session.agentId || "unknown",
      text: "",
      status: "running",
      steps: [],
      touchedShapeIds: [],
    };
    this.transaction( () => {
      agentEntry.seq = this.nextSeq(roomId);
      this.insertEntry(roomId, agentEntry);
      this.db
        .prepare(
          "INSERT INTO runs (run_id,room_id,trigger_id,attempt,lease_hash,lease_expires_at,entry_id,session_id,user_id,agent_id,status,created_at,context) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(runId, roomId, triggerId, attempt, sha256(leaseToken), expiresAt, agentEntry.id, session.sessionId, userId, session.agentId, "running", nowIso(now), null);
      trigger.status = "running";
      trigger.assigneeSessionId = session.sessionId;
      trigger.offerExpiresAt = null;
      trigger.attempt = attempt;
      trigger.runId = runId;
      this.saveTriggerInTx(trigger, row, offeredIds);
    });
    this.flushBroadcasts();
    this.setBusy(roomId, session.sessionId, true);
    return { runId, triggerId, attempt, leaseToken, expiresAt, entryId: agentEntry.id };
  }

  cancelTrigger(userId: string, roomId: string, triggerId: string) {
    this.requireMember(roomId, userId);
    const { trigger, row } = this.loadTrigger(triggerId);
    if (row.room_id !== roomId) throw notFound("trigger not found");
    if (["cancelled", "expired"].includes(trigger.status)) return { trigger };
    if (trigger.status === "done") throw conflict("trigger is already complete");
    const sessionId = trigger.assigneeSessionId;
    this.transaction(() => {
      if (trigger.runId) this.db.prepare("UPDATE runs SET status='superseded' WHERE run_id=? AND status='running'").run(trigger.runId);
      trigger.status = "cancelled";
      trigger.assigneeSessionId = null;
      trigger.offerExpiresAt = null;
      this.saveTriggerInTx(trigger, row);
      if (trigger.runId) {
        const run = this.db.prepare("SELECT entry_id FROM runs WHERE run_id=?").get(trigger.runId) as { entry_id: string } | undefined;
        const entry = run ? this.getEntry(roomId, run.entry_id) : null;
        if (entry?.kind === "agent_turn") {
          entry.status = "cancelled";
          entry.at = nowIso(this.now());
          if (trigger.mode !== "act") entry.hidden = true;
          this.updateEntry(entry);
        }
      }
    });
    this.flushBroadcasts();
    if (sessionId) this.setBusy(roomId, sessionId, false);
    return { trigger };
  }

  retryTrigger(userId: string, roomId: string, triggerId: string, requestId: string) {
    this.requireMember(roomId, userId);
    const idem = this.getIdem<{ trigger: Trigger }>(roomId, "retry", requestId);
    if (idem) return idem;
    const { trigger, row } = this.loadTrigger(triggerId);
    if (row.room_id !== roomId) throw notFound("trigger not found");
    if (!["failed", "cancelled", "expired"].includes(trigger.status)) {
      throw conflict("trigger is not retryable");
    }
    const result = this.transaction( () => {
      // block any late previous run
      this.db
        .prepare("UPDATE runs SET status='superseded' WHERE trigger_id=? AND status='running'")
        .run(triggerId);
      trigger.status = "pending";
      trigger.assigneeSessionId = null;
      trigger.offerExpiresAt = null;
      trigger.runId = null;
      this.saveTriggerInTx(trigger, { entry_id: row.entry_id, offered_ids: "[]" }, []);
      const out = { trigger };
      this.putIdem(roomId, "retry", requestId, out);
      return out;
    });
    this.flushBroadcasts();
    return result;
  }

  private leaseAuth(roomId: string, runId: string, header: string | undefined) {
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    const token = header.slice(7);
    const run = this.db.prepare("SELECT * FROM runs WHERE run_id=? AND room_id=?").get(runId, roomId) as
      | {
          run_id: string;
          trigger_id: string;
          attempt: number;
          lease_hash: string;
          lease_expires_at: number;
          entry_id: string;
          session_id: string;
          user_id: string;
          agent_id: string;
          status: string;
          context: string | null;
        }
      | undefined;
    if (!run || run.lease_hash !== sha256(token)) throw unauthorized("invalid lease");
    return run;
  }

  private activeLease(roomId: string, runId: string, header: string | undefined) {
    const run = this.leaseAuth(roomId, runId, header);
    const { trigger } = this.loadTrigger(run.trigger_id);
    if (run.status !== "running" || run.lease_expires_at <= this.now() || trigger.runId !== runId || trigger.attempt !== run.attempt) {
      throw forbidden("lease is stale or expired");
    }
    return { run, trigger };
  }

  heartbeatRun(roomId: string, runId: string, header: string | undefined) {
    const { run } = this.activeLease(roomId, runId, header);
    const expiresAt = this.now() + this.timings.leaseMs;
    this.db.prepare("UPDATE runs SET lease_expires_at=? WHERE run_id=?").run(expiresAt, run.run_id);
    return { expiresAt };
  }

  runContext(roomId: string, runId: string, header: string | undefined) {
    const { run, trigger } = this.activeLease(roomId, runId, header);
    const causeEntries = trigger.causeEntryIds
      .map((id) => this.getEntry(roomId, id))
      .filter(Boolean);
    const recent = this.db
      .prepare("SELECT data FROM entries WHERE room_id=? ORDER BY seq DESC LIMIT 40")
      .all(roomId) as { data: string }[];
    const recentEntries = recent.map((r) => JSON.parse(r.data)).reverse();
    const canvas = this.contextCanvas(roomId);
    const revision = this.currentRevision(roomId);
    const context = { trigger, causeEntries, recentEntries, canvas, revision };
    this.db.prepare("UPDATE runs SET context=? WHERE run_id=?").run(JSON.stringify({ revision, canvasRevision: this.currentCanvasRevision(roomId), entryIds: [...new Set([...causeEntries, ...recentEntries].map((entry) => entry?.id).filter(Boolean))], shapeIds: canvas.shapes.map((shape) => shape.id), shapes: canvas.shapes }), run.run_id);
    return context;
  }

  private contextCanvas(roomId: string) {
    const records = this.canvasRecords(roomId);
    const shapes = records
      .filter((r) => (r as { typeName?: string }).typeName === "shape")
      .sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)))
      .slice(0, 50)
      .map((shape) => {
        const s = shape as TLBaseShape<string, Record<string, unknown>>;
        return { id: s.id, type: s.type, x: s.x, y: s.y, label: shapeLabel(s), props: boundedContextProps(s.props) };
      });
    const shapeCount = records.filter((r) => (r as { typeName?: string }).typeName === "shape").length;
    return { shapes, truncated: shapeCount > shapes.length, counts: { shapes: shapeCount, records: records.length } };
  }

  private currentCanvasRevision(roomId: string) {
    return sha256(JSON.stringify(this.canvasRecords(roomId).sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)))));
  }

  private currentRevision(roomId: string) {
    const latest = this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM entries WHERE room_id=? AND kind IN ('message','system')").get(roomId) as { seq: number };
    const room = this.getRoomRow(roomId);
    const records = this.canvasRecords(roomId).sort((a, b) => String((a as { id?: string }).id).localeCompare(String((b as { id?: string }).id)));
    const resolutions = this.db.prepare("SELECT id,data FROM entries WHERE room_id=? AND kind IN ('suggestion','offer') AND json_extract(data,'$.status')!='open' ORDER BY id").all(roomId) as { id: string; data: string }[];
    return sha256(JSON.stringify({ seq: latest.seq, records, paused: Boolean(room.assistant_paused), resolutions: resolutions.map((r) => [r.id, JSON.parse(r.data).status]) }));
  }

  runCanvas(roomId: string, runId: string, header: string | undefined, input: { scope: "summary" | "selection" | "full"; shapeIds?: string[] }) {
    this.activeLease(roomId, runId, header);
    if (input.scope === "summary") return this.canvasSummary(roomId);
    const records = this.canvasRecords(roomId);
    const selected = input.scope === "full" ? records : records.filter((r) => input.shapeIds?.includes((r as { id: string }).id));
    if (Buffer.byteLength(JSON.stringify(selected)) > 8 * 1024 * 1024) throw badRequest("canvas response too large; use selection");
    return { records: selected };
  }

  completeRun(roomId: string, runId: string, header: string | undefined, input: { id: string; revision: string; result: AssistantResult }) {
    const authenticated = this.leaseAuth(roomId, runId, header);
    const idem = this.getIdem<{ entry: Entry; outcomeEntry?: Entry }>(roomId, `run-complete:${runId}`, input.id);
    if (idem) return idem;
    const parsed = AssistantResultSchema.safeParse(input.result);
    if (!parsed.success) throw badRequest("invalid assistant result");
    const { run, trigger } = this.activeLease(roomId, runId, header);
    if ((trigger.mode === "context" || trigger.mode === "propose") && parsed.data.kind === "act") throw forbidden("contextual runs cannot mutate");
    if (trigger.mode === "act" && parsed.data.kind === "silent") throw badRequest("explicit runs cannot be silent");
    const sources = parsed.data.kind === "silent" ? [] : parsed.data.sources;
    const storedContext = run.context ? JSON.parse(run.context) as { revision?: string; canvasRevision?: string; entryIds?: string[]; shapeIds?: string[]; shapes?: unknown[] } : null;
    if (!storedContext?.revision) throw badRequest("run context was not captured");
    if (input.revision !== storedContext.revision) {
      if (trigger.mode === "context" || trigger.mode === "propose") {
        this.finishStaleContext(roomId, run, trigger);
        return { entry: this.getEntry(roomId, run.entry_id)! };
      }
      throw conflict("run context is stale");
    }
    this.validateEvidenceSources(roomId, sources, { entryIds: new Set(storedContext.entryIds ?? []), shapeIds: new Set(storedContext.shapeIds ?? []) });
    if ((trigger.mode === "context" || trigger.mode === "propose") && parsed.data.kind !== "silent" && sources.length < 1) throw badRequest("contextual results require a source");
    const currentRevision = this.currentRevision(roomId);
    // Drift since the context was captured only matters for a result that
    // depends on that context still holding. A reply writes nothing, so a
    // second message or a shape someone nudged during the turn cannot make it
    // wrong — and in a live room that drift is the normal case, not the
    // exception. The offline path has always allowed this; holding the room
    // server to a stricter rule failed explicit requests that were fine.
    const canvasChanged = storedContext.canvasRevision !== this.currentCanvasRevision(roomId);
    if (trigger.mode === "act" && input.revision !== currentRevision && parsed.data.kind !== "reply" && canvasChanged) throw conflict("canvas changed while this action was running");
    const staleContext = (trigger.mode === "context" || trigger.mode === "propose") && (input.revision !== currentRevision || storedContext?.revision !== input.revision);
    const assistantResult: AssistantResult = staleContext ? { kind: "silent" } : parsed.data;
    if (trigger.mode === "act" && input.revision && storedContext?.revision && input.revision !== storedContext.revision) throw conflict("run context is stale");

    const handle = this.getRoomHandle(roomId);
    const entry = this.getEntry(roomId, run.entry_id);
    if (!entry || entry.kind !== "agent_turn") throw notFound("agent entry missing");
    let outcomeEntry: Entry | undefined;
    const committed = handle.storage.transaction((txn) => {
      const at = nowIso(this.now());
      if (assistantResult.kind === "act") {
        handle.lastPushUserId = null;
        const shapeIds: string[] = [];
        const provenance = { entryId: entry.id, runId, agentId: run.agent_id, byUserId: run.user_id };
        const puts = this.planMutations(roomId, `${runId}:${input.id}`, assistantResult.operations, provenance, shapeIds);
        if (new Set([...entry.touchedShapeIds, ...shapeIds]).size > 500) throw badRequest("run exceeds touched shape limit");
        for (const record of puts) txn.set((record as { id: string }).id, record as UnknownRecord);
        entry.touchedShapeIds = [...new Set([...entry.touchedShapeIds, ...shapeIds])];
      }
      if (assistantResult.kind === "silent") {
        entry.text = "";
        entry.hidden = true;
      } else {
        entry.text = assistantResult.text;
        entry.sources = assistantResult.sources;
        entry.hidden = assistantResult.kind === "offer" || assistantResult.kind === "draft";
      }
      entry.status = "done";
      entry.at = at;
      this.updateEntry(entry);
      trigger.status = "done";
      trigger.assigneeSessionId = null;
      trigger.offerExpiresAt = null;
      const triggerRow = this.db.prepare("SELECT entry_id,offered_ids FROM triggers WHERE id=?").get(trigger.id) as { entry_id: string; offered_ids: string };
      this.saveTriggerInTx(trigger, triggerRow);
      this.db.prepare("UPDATE runs SET status='done' WHERE run_id=?").run(runId);
      if (assistantResult.kind === "offer") {
        outcomeEntry = { id: uuid(), roomId, seq: this.nextSeq(roomId), at, kind: "offer", triggerId: trigger.id, runId, title: assistantResult.title, request: assistantResult.request, text: assistantResult.text, sources: assistantResult.sources, status: "open", resolvedBy: null, resultTriggerId: null, revision: input.revision };
        this.insertEntry(roomId, outcomeEntry);
      } else if (assistantResult.kind === "draft") {
        const expectedDraft = assistantResult.targetShapeId ? ((storedContext.shapes ?? []).find((shape) => (shape as { id?: string }).id === assistantResult.targetShapeId) as { props?: { draft?: NodeDraft } } | undefined)?.props?.draft : undefined;
        if (assistantResult.targetShapeId && !expectedDraft) throw badRequest("draft target was not in supplied context");
        outcomeEntry = { id: uuid(), roomId, seq: this.nextSeq(roomId), at, kind: "suggestion", triggerId: trigger.id, runId, draft: assistantResult.draft, status: "open", shapeId: null, text: assistantResult.text, sources: assistantResult.sources, ...(assistantResult.targetShapeId ? { targetShapeId: assistantResult.targetShapeId, expectedDraft } : {}), revision: input.revision, resolvedBy: null };
        this.insertEntry(roomId, outcomeEntry);
      }
      const result = { entry, ...(outcomeEntry ? { outcomeEntry } : {}) };
      this.putIdem(roomId, `run-complete:${runId}`, input.id, result);
      return result;
    });
    const result = (committed as { result?: { entry: Entry; outcomeEntry?: Entry } }).result ?? committed as unknown as { entry: Entry; outcomeEntry?: Entry };
    this.flushBroadcasts();
    this.setBusy(roomId, authenticated.session_id, false);
    this.tick();
    return result;
  }

  private finishStaleContext(roomId: string, run: { run_id: string; session_id: string; entry_id: string }, trigger: Trigger) {
    const entry = this.getEntry(roomId, run.entry_id);
    this.transaction(() => {
      if (entry?.kind === "agent_turn") { entry.status = "done"; entry.hidden = true; entry.text = ""; entry.at = nowIso(this.now()); this.updateEntry(entry); }
      trigger.status = "done"; trigger.assigneeSessionId = null; trigger.offerExpiresAt = null;
      const row = this.db.prepare("SELECT entry_id,offered_ids FROM triggers WHERE id=?").get(trigger.id) as { entry_id: string; offered_ids: string };
      this.saveTriggerInTx(trigger, row);
      this.db.prepare("UPDATE runs SET status='done' WHERE run_id=?").run(run.run_id);
    });
    this.flushBroadcasts();
    this.setBusy(roomId, run.session_id, false);
  }

  private validateEvidenceSources(roomId: string, sources: unknown[], supplied: { entryIds: Set<string>; shapeIds: Set<string> }) {
    const parsed = EvidenceSourcesSchema.safeParse(sources);
    if (!parsed.success) throw badRequest("invalid evidence sources");
    const records = new Set(this.canvasRecords(roomId).map((record) => (record as { id?: string }).id));
    for (const source of parsed.data) {
      if (source.kind === "entry") {
        const entry = this.getEntry(roomId, source.id);
        if (!entry || entry.kind === "agent_turn" || entry.kind === "trigger" || !supplied.entryIds.has(source.id)) throw badRequest("evidence entry is not available");
      } else if (!records.has(source.id) || !supplied.shapeIds.has(source.id)) throw badRequest("evidence shape is not in this room");
    }
  }

  private currentDraft(roomId: string, targetShapeId: string): NodeDraft | undefined {
    const record = this.canvasRecords(roomId).find((candidate) => (candidate as { id?: string }).id === targetShapeId) as { typeName?: string; type?: string; props?: { draft?: NodeDraft } } | undefined;
    if (!record || record.typeName !== "shape" || record.type !== KAN_NODE_TYPE || !record.props?.draft) throw badRequest("draft target is not a shared kan-node");
    return record.props.draft;
  }

  patchRun(
    roomId: string,
    runId: string,
    header: string | undefined,
    input: { id: string; text?: string; steps?: unknown[]; status?: "done" | "failed" | "cancelled" },
  ) {
    const run = this.leaseAuth(roomId, runId, header);
    const currentTrigger = this.loadTrigger(run.trigger_id).trigger;
    if ((currentTrigger.mode === "context" || currentTrigger.mode === "propose") && (input.text !== undefined || input.steps !== undefined || input.status === "done")) throw forbidden("contextual output must use complete");
    const idem = this.getIdem<{ entry: Entry }>(roomId, `run-patch:${runId}`, input.id);
    if (idem) return idem;
    const { trigger } = this.activeLease(roomId, runId, header);
    const entry = this.getEntry(roomId, run.entry_id);
    if (!entry || entry.kind !== "agent_turn") throw notFound("agent entry missing");
    const result = this.transaction( () => {
      if (input.text !== undefined) entry.text = input.text;
      if (input.steps !== undefined) entry.steps = input.steps;
      if (input.status !== undefined) {
        entry.status = input.status;
        trigger.status = input.status === "done" ? "done" : input.status === "cancelled" ? "cancelled" : "failed";
        const row = this.db.prepare("SELECT entry_id, offered_ids FROM triggers WHERE id=?").get(trigger.id) as {
          entry_id: string;
          offered_ids: string;
        };
        this.saveTriggerInTx(trigger, row);
        this.db.prepare("UPDATE runs SET status=? WHERE run_id=?").run(input.status === "done" ? "done" : input.status === "cancelled" ? "superseded" : "failed", runId);
      }
      entry.at = nowIso(this.now());
      this.updateEntry(entry);
      const out = { entry };
      this.putIdem(roomId, `run-patch:${runId}`, input.id, out);
      return out;
    });
    this.flushBroadcasts();
    if (input.status) this.setBusy(roomId, run.session_id, false);
    return result;
  }

  // ---------- mutations ----------

  mutate(
    roomId: string,
    runId: string,
    header: string | undefined,
    input: { id: string; operations: Mutation[] },
  ): { shapeIds: string[] } {
    const { run, trigger } = this.activeLease(roomId, runId, header);
    if (trigger.mode !== "act") throw forbidden("propose-mode runs cannot mutate the canvas");
    const idem = this.getIdem<{ shapeIds: string[] }>(roomId, `mutate:${runId}`, input.id);
    if (idem) return idem as { shapeIds: string[] };
    const handle = this.getRoomHandle(roomId);
    handle.lastPushUserId = null;
    const agentEntry = this.getEntry(roomId, run.entry_id);
    if (!agentEntry || agentEntry.kind !== "agent_turn") throw notFound("agent entry missing");
    const provenance = { entryId: agentEntry.id, runId, agentId: run.agent_id, byUserId: run.user_id };
    const shapeIds: string[] = [];
    const result = handle.storage.transaction((txn) => {
      const puts = this.planMutations(roomId, `${runId}:${input.id}`, input.operations, provenance, shapeIds);
      for (const rec of puts) txn.set((rec as { id: string }).id, rec as UnknownRecord);
      const touched = new Set(agentEntry.touchedShapeIds);
      for (const id of shapeIds) touched.add(id);
      if (touched.size > 500) throw badRequest("run exceeds touched shape limit");
      agentEntry.touchedShapeIds = [...touched];
      agentEntry.at = nowIso(this.now());
      this.updateEntry(agentEntry);
      this.putIdem(roomId, `mutate:${runId}`, input.id, { shapeIds });
      return { shapeIds };
    });
    this.flushBroadcasts();
    return result.result as { shapeIds: string[] };
  }

  private planMutations(
    roomId: string,
    requestId: string,
    operations: Mutation[],
    provenance: TLBaseShape<string, Record<string, unknown>>["meta"],
    shapeIds: string[],
  ): unknown[] {
    const handle = this.getRoomHandle(roomId);
    const snapshot = handle.storage.getSnapshot();
    const current = new Map<string, UnknownRecord>();
    for (const d of snapshot.documents) current.set(d.state.id, d.state);
    const pageId = [...current.values()].find((r) => (r as { typeName?: string }).typeName === "page")?.id as
      | string
      | undefined;
    if (!pageId) throw badRequest("room has no page");
    const puts: UnknownRecord[] = [];
    const planned = new Map<string, UnknownRecord>();
    const get = (id: string) => planned.get(id) ?? current.get(id);
    let maxIndex: IndexKey = "a0" as IndexKey;
    for (const r of current.values()) {
      const rec = r as { typeName?: string; index?: string };
      if (rec.typeName === "shape" && typeof rec.index === "string" && rec.index > maxIndex) maxIndex = rec.index as IndexKey;
    }

    operations.forEach((op, i) => {
      if (op.type === "diagram") {
        const { type: _type, ...graph } = op;
        const near = op.nearShapeId ? get(op.nearShapeId) as TLBaseShape<string, Record<string, unknown>> | undefined : undefined;
        if (op.nearShapeId && (!near || near.typeName !== "shape" || !near.parentId.startsWith("page:") || near.rotation !== 0 || near.isLocked)) throw badRequest("diagram target must be an unlocked top-level shape");
        const targetPageId = near?.parentId ?? pageId;
        const origin = diagramPlacement([...current.values(), ...planned.values()] as unknown as TLBaseShape<string, Record<string, unknown>>[], targetPageId);
        const plan = planDiagram(graph, { id: key => deterministicId(key, runKey(requestId, i)), pageId: targetPageId, origin, provenance });
        for (const shape of plan.shapes) {
          if (get(shape.id)) throw conflict("diagram was already applied");
          maxIndex = getIndexAbove(maxIndex);
          const record = { rotation: 0, isLocked: false, opacity: 1, ...shape, typeName: "shape", index: maxIndex } as unknown as UnknownRecord;
          planned.set(record.id, record); puts.push(record); shapeIds.push(shape.id);
        }
        for (const binding of plan.bindings) {
          const record = { ...binding, typeName: "binding" } as UnknownRecord;
          planned.set(record.id, record); puts.push(record);
        }
      } else if (op.type === "add") {
        const id = (op.shapeId ?? `shape:${deterministicId(`add`, runKey(requestId, i))}`) as `shape:${string}`;
        if (get(id)) throw conflict(`shape ${id} already exists`);
        const origin = diagramPlacement([...current.values(), ...planned.values()] as unknown as TLBaseShape<string, Record<string, unknown>>[], pageId, { x: 0, y: 0 });
        let x = op.x ?? origin.x;
        let y = op.y ?? origin.y;
        let targetPageId = pageId;
        if (op.nearShapeId) {
          const near = get(op.nearShapeId) as TLBaseShape<string, Record<string, unknown>> | undefined;
          if (!near || (near as { typeName?: string }).typeName !== "shape") throw badRequest(`nearShapeId ${op.nearShapeId} not found`);
          if (!near.parentId.startsWith("page:") || near.rotation !== 0) throw badRequest("unsupported near coordinate space");
          targetPageId = near.parentId;
          if (op.x === undefined) x = near.x + ((near.props?.w as number) ?? 200) + 80;
          if (op.y === undefined) y = near.y;
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw badRequest("coordinates must be finite");
        maxIndex = getIndexAbove(maxIndex);
        const isMap = op.draft.type === "map";
        const isTable = op.draft.type === "table";
        const shape: UnknownRecord = {
          id,
          typeName: "shape",
          type: isMap ? KAN_MAP_TYPE : isTable ? KAN_TABLE_TYPE : KAN_NODE_TYPE,
          x,
          y,
          rotation: 0,
          index: maxIndex,
          parentId: targetPageId,
          isLocked: false,
          opacity: 1,
          props: op.draft.type === "map" ? mapShapeProps(op.draft) : op.draft.type === "table" ? tableShapeProps(op.draft) : { ...kanNodeSize(op.draft.type), draft: op.draft },
          meta: { provenance },
        } as unknown as UnknownRecord;
        planned.set(id, shape);
        puts.push(shape);
        shapeIds.push(id);
      } else if (op.type === "update") {
        const existing = get(op.shapeId) as TLBaseShape<string, Record<string, unknown>> | undefined;
        if (!existing || existing.typeName !== "shape") throw badRequest(`shape ${op.shapeId} not found`);
        if (existing.type !== KAN_NODE_TYPE && existing.type !== KAN_MAP_TYPE && existing.type !== KAN_TABLE_TYPE) throw badRequest("only Kan node, map, or table shapes can be updated");
        if ((existing.type === KAN_MAP_TYPE) !== (op.draft.type === "map") || (existing.type === KAN_TABLE_TYPE) !== (op.draft.type === "table")) throw badRequest("rich node updates require a matching draft");
        const next = {
          ...existing,
          props: existing.type === KAN_MAP_TYPE ? mapShapeProps(op.draft as Extract<NodeDraft, { type: "map" }>) : existing.type === KAN_TABLE_TYPE ? tableShapeProps(op.draft as Extract<NodeDraft, { type: "table" }>) : { ...existing.props, draft: op.draft },
          meta: { ...existing.meta, provenance },
        } as unknown as UnknownRecord;
        planned.set(op.shapeId, next);
        puts.push(next);
        shapeIds.push(op.shapeId);
      } else if (op.type === "group") {
        const shapes = op.shapeIds.map((id) => get(id) as TLBaseShape<string, Record<string, unknown>> | undefined);
        if (shapes.some((shape) => !shape || shape.typeName !== "shape" || shape.parentId !== pageId || shape.rotation !== 0 || shape.isLocked)) throw badRequest("group requires unlocked top-level shapes on the current page");
        const members = shapes as TLBaseShape<string, Record<string, unknown>>[];
        const measured = members.map((shape) => ({ shape, bounds: shapePageBounds(shape) }));
        const origin = { x: Math.min(...measured.map(({ bounds }) => bounds.x)) - GROUP_PADDING, y: Math.min(...measured.map(({ bounds }) => bounds.y)) - GROUP_PADDING };
        const layout = layoutGroup(measured.map(({ shape, bounds }) => ({ id: shape.id as TLShapeId, w: bounds.w, h: bounds.h })), origin);
        const groupId = `shape:${deterministicId("group", runKey(requestId, i))}`;
        if (get(groupId)) throw conflict(`shape ${groupId} already exists`);
        maxIndex = getIndexAbove(maxIndex);
        const frame: UnknownRecord = {
          id: groupId,
          typeName: "shape",
          type: "frame",
          x: origin.x,
          y: origin.y,
          rotation: 0,
          index: maxIndex,
          parentId: pageId,
          isLocked: false,
          opacity: 1,
          props: { w: layout.w, h: layout.h, name: "Group", color: "black" },
          meta: { provenance, kanGroup: true },
        } as unknown as UnknownRecord;
        planned.set(groupId, frame);
        puts.push(frame);
        shapeIds.push(groupId);
        for (const position of layout.positions) {
          const shape = get(position.id) as TLBaseShape<string, Record<string, unknown>>;
          const next = { ...shape, parentId: groupId, x: position.x, y: position.y, meta: { ...shape.meta, provenance } } as unknown as UnknownRecord;
          planned.set(shape.id, next);
          puts.push(next);
          shapeIds.push(shape.id);
        }
      } else if (op.type === "style" || op.type === "label") {
        const existing = get(op.shapeId) as TLBaseShape<string, Record<string, unknown>> | undefined;
        if (!existing || existing.typeName !== "shape" || existing.type !== "geo") throw badRequest("color or label changes require a native geometric shape");
        if (existing.isLocked) throw badRequest("unlock the shape before changing it");
        const patch = op.type === "style" ? { color: op.color } : { richText: richTextOf(op.text) };
        const next = { ...existing, props: { ...existing.props, ...patch }, meta: { ...existing.meta, provenance } } as unknown as UnknownRecord;
        planned.set(op.shapeId, next);
        puts.push(next);
        shapeIds.push(op.shapeId);
      } else if (op.type === "connect") {
        const from = get(op.from) as TLBaseShape<string, Record<string, unknown>> | undefined;
        const to = get(op.to) as TLBaseShape<string, Record<string, unknown>> | undefined;
        if (!from || (from as { typeName?: string }).typeName !== "shape") throw badRequest(`connect source ${op.from} not found`);
        if (!to || (to as { typeName?: string }).typeName !== "shape") throw badRequest(`connect target ${op.to} not found`);
        if (!from.parentId.startsWith("page:") || from.parentId !== to.parentId || from.rotation !== 0 || to.rotation !== 0) throw badRequest("unsupported connect coordinate space");
        const arrowId = `shape:${deterministicId("connect", runKey(requestId, i))}` as `shape:${string}`;
        if (get(arrowId)) throw conflict(`shape ${arrowId} already exists`);
        maxIndex = getIndexAbove(maxIndex);
        const start = centerOf(from);
        const end = centerOf(to);
        const arrow = {
          id: arrowId,
          typeName: "shape",
          type: "arrow",
          x: start.x,
          y: start.y,
          rotation: 0,
          index: maxIndex,
          parentId: from.parentId,
          isLocked: false,
          opacity: 1,
          props: {
            kind: "arc",
            labelColor: "black",
            color: "black",
            fill: "none",
            dash: "draw",
            size: "m",
            arrowheadStart: "none",
            arrowheadEnd: "arrow",
            font: "draw",
            start: { x: 0, y: 0 },
            end: { x: end.x - start.x, y: end.y - start.y },
            bend: 0,
            richText: richTextOf(op.label ?? ""),
            labelPosition: 0.5,
            scale: 1,
            elbowMidPoint: 0.5,
          },
          meta: { provenance },
        } as unknown as UnknownRecord;
        planned.set(arrowId, arrow);
        puts.push(arrow);
        for (const [terminal, targetId] of [
          ["start", op.from],
          ["end", op.to],
        ] as const) {
          const binding = {
            id: `binding:${deterministicId(`bind-${terminal}`, runKey(requestId, i))}`,
            typeName: "binding",
            type: "arrow",
            fromId: arrowId,
            toId: targetId,
            props: {
              terminal,
              normalizedAnchor: { x: 0.5, y: 0.5 },
              isExact: false,
              isPrecise: false,
              snap: "none",
            },
            meta: {},
          } as unknown as UnknownRecord;
          planned.set(binding.id as string, binding);
          puts.push(binding);
        }
        shapeIds.push(arrowId);
      } else if (op.type === "arrange") {
        const shapes = op.shapeIds.map((id) => {
          const s = get(id) as TLBaseShape<string, Record<string, unknown>> | undefined;
          if (!s || (s as { typeName?: string }).typeName !== "shape") throw badRequest(`shape ${id} not found`);
          return s;
        });
        if (shapes.some((s) => s.parentId !== shapes[0].parentId)) throw badRequest("arrange requires siblings");
        const gapX = 380;
        const gapY = 280;
        const cols = op.layout === "grid" ? Math.ceil(Math.sqrt(shapes.length)) : op.layout === "row" ? shapes.length : 1;
        const originX = shapes[0].x;
        const originY = shapes[0].y;
        shapes.forEach((s, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const next = { ...s, x: originX + col * gapX, y: originY + row * gapY, meta: { ...s.meta, provenance } } as unknown as UnknownRecord;
          planned.set(s.id, next);
          puts.push(next);
          shapeIds.push(s.id);
        });
      }
    });
    for (const rec of puts) {
      try { this.schema.types[rec.typeName as keyof typeof this.schema.types].validator.validate(rec); } catch { throw badRequest("planned record failed schema validation"); }
    }
    for (const rec of puts) current.set(rec.id, rec);
    this.validateGraph(graphRecords([...current.values()]));
    return puts;
  }

  // ---------- suggestions ----------

  createSuggestion(
    roomId: string,
    runId: string,
    header: string | undefined,
    input: { id: string; draft: NodeDraft },
  ) {
    const { run, trigger } = this.activeLease(roomId, runId, header);
    if (trigger.mode !== "propose") throw forbidden("only propose-mode runs can create suggestions");
    const idem = this.getIdem<{ entry: Entry }>(roomId, `suggestion:${runId}`, input.id);
    if (idem) return idem;
    const at = nowIso(this.now());
    const entry: Entry = {
      id: input.id,
      roomId,
      seq: 0,
      at,
      kind: "suggestion",
      triggerId: trigger.id,
      runId,
      draft: input.draft,
      status: "open",
      shapeId: null,
    };
    this.transaction( () => {
      entry.seq = this.nextSeq(roomId);
      this.insertEntry(roomId, entry);
      this.putIdem(roomId, `suggestion:${runId}`, input.id, { entry });
    });
    this.flushBroadcasts();
    return { entry };
  }

  resolveOffer(userId: string, roomId: string, entryId: string, resolution: "accepted" | "dismissed") {
    this.requireMember(roomId, userId);
    const offer = this.getEntry(roomId, entryId);
    if (!offer || offer.kind !== "offer") throw notFound("offer not found");
    if (offer.status !== "open") {
      if (offer.status === resolution) return { entry: offer, trigger: offer.resultTriggerId ? this.loadTrigger(offer.resultTriggerId).trigger : undefined };
      throw conflict(`offer already ${offer.status}`);
    }
    if (resolution === "dismissed") {
      this.transaction(() => {
        offer.status = "dismissed";
        offer.resolvedBy = userId;
        offer.at = nowIso(this.now());
        this.updateEntry(offer);
      });
      this.flushBroadcasts();
      return { entry: offer };
    }
    if (offer.revision !== this.currentRevision(roomId)) {
      this.transaction(() => {
        offer.status = "outdated";
        offer.resolvedBy = userId;
        offer.at = nowIso(this.now());
        this.updateEntry(offer);
      });
      this.flushBroadcasts();
      throw conflict("offer is outdated");
    }
    const supporting = this.loadTrigger(offer.triggerId).trigger.causeEntryIds.filter((id) => {
      const entry = this.getEntry(roomId, id);
      return entry?.kind === "message" || entry?.kind === "system";
    });
    let trigger!: Trigger;
    this.transaction(() => {
      trigger = this.createTrigger(roomId, offer, { mode: "act", intent: "lookup", confidence: 1, reason: offer.request }, [], "accepted", userId, { causeEntryIds: [entryId, ...supporting], approvedRequest: offer.request, acceptedOfferId: entryId }, true);
      offer.status = "accepted";
      offer.resolvedBy = userId;
      offer.resultTriggerId = trigger.id;
      offer.at = nowIso(this.now());
      this.updateEntry(offer);
    });
    this.flushBroadcasts();
    this.tick();
    return { entry: offer, trigger };
  }

  resolveSuggestion(userId: string, roomId: string, entryId: string, resolution: "accepted" | "dismissed") {
    this.requireMember(roomId, userId);
    const entry = this.getEntry(roomId, entryId);
    if (!entry || entry.kind !== "suggestion") throw notFound("suggestion not found");
    if (entry.status !== "open") {
      if (entry.status === resolution) return { entry, shapeId: entry.shapeId };
      throw conflict(`suggestion already ${entry.status}`);
    }
    const at = nowIso(this.now());
    if (resolution === "accepted" && entry.revision && entry.revision !== this.currentRevision(roomId)) {
      this.transaction(() => { entry.status = "outdated"; entry.resolvedBy = userId; entry.at = at; this.updateEntry(entry); });
      this.flushBroadcasts();
      throw conflict("suggestion is outdated");
    }
    if (resolution === "dismissed") {
      this.transaction( () => {
        entry.status = "dismissed";
        entry.acceptedBy = null;
        entry.resolvedBy = userId;
        entry.at = at;
        this.updateEntry(entry);
      });
      this.flushBroadcasts();
      return { entry, shapeId: null };
    }
    // accepted: atomically create the node and update the entry
    const run = this.db.prepare("SELECT * FROM runs WHERE run_id=?").get(entry.runId) as
      | { agent_id: string; user_id: string; entry_id: string }
      | undefined;
    const provenance = {
      entryId,
      runId: entry.runId,
      agentId: run?.agent_id ?? "unknown",
      byUserId: run?.user_id ?? userId,
      acceptedBy: userId,
    };
    const handle = this.getRoomHandle(roomId);
    handle.lastPushUserId = null;
    if (entry.targetShapeId) {
      const targetShapeId = entry.targetShapeId;
      let currentDraft: NodeDraft | undefined;
      try { currentDraft = this.currentDraft(roomId, targetShapeId); } catch {
        this.transaction(() => { entry.status = "outdated"; entry.resolvedBy = userId; entry.at = at; this.updateEntry(entry); });
        this.flushBroadcasts();
        throw conflict("suggestion target is outdated");
      }
      if (!entry.expectedDraft || !isDeepStrictEqual(currentDraft, entry.expectedDraft)) {
        this.transaction(() => {
          entry.status = "outdated";
          entry.resolvedBy = userId;
          entry.at = at;
          this.updateEntry(entry);
        });
        this.flushBroadcasts();
        throw conflict("suggestion target changed");
      }
      handle.storage.transaction((txn) => {
        const records = new Map(Array.from(txn.entries()).map(([id, record]) => [id, record]));
        const target = records.get(targetShapeId) as { props?: Record<string, unknown>; meta?: Record<string, unknown> } | undefined;
        if (!target) throw conflict("suggestion target is outdated");
        const originEntry = run ? this.getEntry(roomId, run.entry_id) : null;
        if (originEntry?.kind === "agent_turn") {
          originEntry.touchedShapeIds = [...new Set([...originEntry.touchedShapeIds, targetShapeId])];
          originEntry.at = at;
          this.updateEntry(originEntry);
        }
        txn.set(targetShapeId, { ...target, props: { ...(target.props ?? {}), draft: entry.draft }, meta: { ...(target.meta ?? {}), provenance: { entryId, runId: entry.runId, byUserId: userId } } } as unknown as UnknownRecord);
        entry.status = "accepted";
        entry.shapeId = targetShapeId;
        entry.acceptedBy = userId;
        entry.resolvedBy = userId;
        entry.at = at;
        this.updateEntry(entry);
      });
      this.flushBroadcasts();
      return { entry, shapeId: entry.targetShapeId! };
    }
    let shapeId = "";
    handle.storage.transaction((txn) => {
      const pageId = [...txn.entries()].find(([, r]) => (r as { typeName?: string }).typeName === "page")?.[0] as
        | string
        | undefined;
      if (!pageId) throw badRequest("room has no page");
      let maxIndex: IndexKey = "a0" as IndexKey;
      for (const [, r] of txn.entries()) {
        const rec = r as { typeName?: string; index?: string };
        if (rec.typeName === "shape" && typeof rec.index === "string" && rec.index > maxIndex) {
          maxIndex = rec.index as IndexKey;
        }
      }
      shapeId = `shape:${deterministicId("suggest", `${entryId}:0`)}`;
      const shape = {
        id: shapeId,
        typeName: "shape",
        type: KAN_NODE_TYPE,
        x: 120 + (entry.seq % 8) * 60,
        y: 120 + (entry.seq % 8) * 60,
        rotation: 0,
        index: getIndexAbove(maxIndex),
        parentId: pageId,
        isLocked: false,
        opacity: 1,
        props: { ...kanNodeSize(entry.draft.type), draft: entry.draft },
        meta: { provenance },
      } as unknown as UnknownRecord;
      if (txn.get(shapeId)) throw conflict("suggestion shape already exists");
      this.validateGraph(graphRecords([...txn.entries()].map(([, r]) => r).concat(shape)));
      const originEntry = run ? this.getEntry(roomId, run.entry_id) : null;
      if (originEntry?.kind === "agent_turn") {
        const touched = new Set([...originEntry.touchedShapeIds, shapeId]);
        if (touched.size > 500) throw badRequest("run exceeds touched shape limit");
        originEntry.touchedShapeIds = [...touched];
        originEntry.at = at;
        this.updateEntry(originEntry);
      }
      txn.set(shapeId, shape);
      entry.status = "accepted";
      entry.shapeId = shapeId;
      entry.acceptedBy = userId;
      entry.resolvedBy = userId;
      entry.at = at;
      this.updateEntry(entry);
    });
    this.flushBroadcasts();
    return { entry, shapeId };
  }

  // ---------- data query / video ----------

  dataQuery(roomId: string, header: string | undefined, input: { source: "demo-metrics"; metric: "throughput" | "latencyMs" | "errorRate"; from?: string; to?: string }) {
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    const token = header.slice(7);
    const run = this.db
      .prepare("SELECT * FROM runs WHERE room_id=? AND lease_hash=? AND status='running' AND lease_expires_at>?")
      .get(roomId, sha256(token), this.now());
    if (!run) throw unauthorized("no active lease for this room");
    const trigger = this.loadTrigger((run as { trigger_id: string }).trigger_id).trigger;
    if (trigger.mode === "context" || trigger.mode === "propose") throw forbidden("contextual runs cannot query data");
    return queryDemoData(input);
  }

  async startCaptions(userId: string, roomId: string) {
    this.requireMember(roomId, userId);
    if (!this.video?.startCaptions) throw unavailable("live transcription is not configured");
    const handle = this.getRoomHandle(roomId);
    if (handle.captionsCheckedAt !== undefined && this.now() - handle.captionsCheckedAt < 10_000) return;
    if (!handle.captionsPromise) {
      handle.captionsPromise = (async () => {
        try {
          const { sessionId } = await this.videoToken(userId, roomId);
          const token = this.video!.generateClientToken(sessionId, {
            role: "moderator", expireTime: Math.floor(this.now() / 1000) + 300, data: "kan-captions",
          });
          await this.video!.startCaptions!(sessionId, token);
          handle.captionsCheckedAt = this.now();
        } catch { throw badGateway("live transcription could not start"); }
        finally { handle.captionsPromise = undefined; }
      })();
    }
    await handle.captionsPromise;
  }

  async videoToken(userId: string, roomId: string) {
    this.requireMember(roomId, userId);
    if (!this.video) throw unavailable("video is not configured");
    const handle = this.getRoomHandle(roomId);
    let sessionPromise = handle.videoSessionPromise;
    const existing = this.db.prepare("SELECT video_session_id FROM rooms WHERE id=?").get(roomId) as
      | { video_session_id: string | null }
      | undefined;
    if (!existing?.video_session_id) {
      if (!sessionPromise) {
        sessionPromise = (async () => {
          try {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 5000); });
            const s = await Promise.race([this.video!.createSession(), timeout]).finally(() => clearTimeout(timer));
            this.db.prepare("UPDATE rooms SET video_session_id=? WHERE id=?").run(s.sessionId, roomId);
            return s.sessionId;
          } catch (e) {
            handle.videoSessionPromise = null;
            throw badGateway("video provider failed");
          }
        })();
        handle.videoSessionPromise = sessionPromise;
      }
    } else {
      sessionPromise = Promise.resolve(existing.video_session_id);
    }
    const sessionId = await sessionPromise.finally(() => { handle.videoSessionPromise = null; });
    const user = this.db.prepare("SELECT name FROM users WHERE id=?").get(userId) as { name: string };
    const expireTime = Math.floor(this.now() / 1000) + 1800;
    try {
      const token = this.video.generateClientToken(sessionId, {
        role: "publisher",
        expireTime,
        data: JSON.stringify({ id: userId, name: user.name }),
      });
      return { applicationId: this.video.applicationId, sessionId, token, expiresAt: expireTime };
    } catch { throw badGateway("video provider failed"); }
  }

  // ---------- idempotency ----------

  private getIdem<T>(roomId: string, scope: string, requestId: string): T | null {
    const row = this.db
      .prepare("SELECT result FROM idem WHERE room_id=? AND scope=? AND request_id=?")
      .get(roomId, scope, requestId) as { result: string } | undefined;
    return row ? JSON.parse(row.result) as T : null;
  }

  private putIdem(roomId: string, scope: string, requestId: string, result: unknown) {
    this.db
      .prepare("INSERT INTO idem (room_id,scope,request_id,result) VALUES (?,?,?,?)")
      .run(roomId, scope, requestId, JSON.stringify(result));
  }
}

function entryAuthorId(entry: Entry): string | null {
  if (entry.kind === "message" || entry.kind === "system") return entry.authorId;
  if (entry.kind === "trigger") return entry.trigger.requestedBy;
  if (entry.kind === "agent_turn") return entry.byUserId;
  return null;
}

function causeAnchors(cause: Entry): string[] {
  if (cause.kind === "message") return [...cause.anchors];
  if (cause.kind === "system") return cause.shapeIds.filter((id) => /^shape:[A-Za-z0-9_-]{1,80}$/.test(id)).slice(0, 64);
  return [];
}

function stripProvenance(rec: Record<string, unknown>): Record<string, unknown> {
  const meta = (rec.meta ?? {}) as Record<string, unknown>;
  if (!("provenance" in meta)) return rec;
  const { provenance: _drop, ...rest } = meta;
  return { ...rec, meta: rest };
}

function deterministicId(prefix: string, key: string): string {
  const hex = sha256(`${prefix}:${key}`).slice(0, 24);
  return `k${hex}`;
}

function runKey(requestId: string, index: number) {
  return `${requestId}:${index}`;
}

function centerOf(shape: TLBaseShape<string, Record<string, unknown>>) {
  return { x: shape.x + ((shape.props?.w as number) ?? 100) / 2, y: shape.y + ((shape.props?.h as number) ?? 100) / 2 };
}

function richTextOf(text: string) {
  if (!text) return { type: "doc", content: [] };
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function extractRichText(value: unknown): string {
  try {
    const parts: string[] = [];
    const walk = (n: unknown) => {
      if (!n || typeof n !== "object") return;
      const node = n as { type?: string; text?: string; content?: unknown[] };
      if (node.type === "text" && typeof node.text === "string") parts.push(node.text);
      if (Array.isArray(node.content)) node.content.forEach(walk);
    };
    walk(value);
    return parts.join(" ");
  } catch {
    return "";
  }
}

const GROUP_PADDING = 28;
const GROUP_GAP = 20;

function shapePageBounds(shape: TLBaseShape<string, Record<string, unknown>>) {
  const props = shape.props as { w?: unknown; h?: unknown };
  const w = typeof props.w === "number" && Number.isFinite(props.w) ? props.w : 320;
  const h = typeof props.h === "number" && Number.isFinite(props.h) ? props.h : 200;
  return { x: shape.x, y: shape.y, w: Math.max(1, w), h: Math.max(1, h) };
}

function layoutGroup(items: Array<{ id: TLShapeId; w: number; h: number }>, origin: { x: number; y: number }) {
  const columns = Math.ceil(Math.sqrt(items.length));
  const rows = Math.ceil(items.length / columns);
  const columnWidths = Array.from({ length: columns }, () => 0);
  const rowHeights = Array.from({ length: rows }, () => 0);
  for (const [index, item] of items.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths[column] = Math.max(columnWidths[column], item.w);
    rowHeights[row] = Math.max(rowHeights[row], item.h);
  }
  const xOffsets = columnWidths.map((_, index) => columnWidths.slice(0, index).reduce((sum, width) => sum + width + GROUP_GAP, 0));
  const yOffsets = rowHeights.map((_, index) => rowHeights.slice(0, index).reduce((sum, height) => sum + height + GROUP_GAP, 0));
  return {
    x: origin.x,
    y: origin.y,
    w: GROUP_PADDING * 2 + columnWidths.reduce((sum, width) => sum + width, 0) + GROUP_GAP * (columns - 1),
    h: GROUP_PADDING * 2 + rowHeights.reduce((sum, height) => sum + height, 0) + GROUP_GAP * (rows - 1),
    positions: items.map((item, index) => ({
      id: item.id,
      x: GROUP_PADDING + xOffsets[index % columns],
      y: GROUP_PADDING + yOffsets[Math.floor(index / columns)],
    })),
  };
}

function tableShapeProps(draft: Extract<NodeDraft, { type: "table" }>) {
  return {
    ...kanNodeSize("table"),
    title: draft.title,
    columns: draft.columns,
    rows: draft.rows,
    highlightRow: -1,
    sourceNote: draft.sourceNote ?? "",
    sortBy: null,
    selectedRows: [],
  };
}

function mapShapeProps(draft: Extract<NodeDraft, { type: "map" }>) {
  return {
    ...kanNodeSize("map"),
    title: draft.title,
    markers: draft.markers,
    center: draft.center ?? null,
    zoom: draft.zoom ?? null,
    style: draft.style ?? "aquarelle",
    selectedMarker: -1,
  };
}

function boundedContextProps(props: unknown): unknown {
  if (!props || typeof props !== "object") return {};
  const text = JSON.stringify(props);
  if (text.length <= 12_000) return props;
  return { truncated: true, preview: text.slice(0, 11_800) };
}

function shapeLabel(shape: UnknownRecord): string {
  const s = shape as TLBaseShape<string, Record<string, unknown>>;
  const props = (s.props ?? {}) as Record<string, unknown>;
  if (s.type === KAN_NODE_TYPE) {
    const draft = props.draft as NodeDraft | undefined;
    if (draft) {
      const label =
        draft.type === "concept" ? draft.label : draft.title;
      if (label) return label.slice(0, 240);
    }
  }
  for (const key of ["label", "title", "name", "text"]) {
    const v = props[key];
    if (typeof v === "string" && v) return v.slice(0, 240);
  }
  const rich = extractRichText(props.richText);
  if (rich) return rich.slice(0, 240);
  const url = props.url;
  if (typeof url === "string") return url.slice(0, 240);
  return "";
}

function defaultDocumentRecord(): UnknownRecord {
  return { id: "document:document", typeName: "document", name: "", gridSize: 10, meta: {} } as unknown as UnknownRecord;
}

function defaultPageRecord(): UnknownRecord {
  return { id: "page:page", typeName: "page", name: "Page 1", index: "a1", meta: {} } as unknown as UnknownRecord;
}
