/**
 * Thread domain model.
 *
 * The thread is the append-only source of truth for a room. Entries arrive from
 * three independent sources and are interleaved by timestamp:
 *
 *   - `transcript` — speech-to-text of the call, attributed to the speaker
 *   - `message`    — typed by a participant (may carry images / canvas anchors)
 *   - `agent`      — output of a participant's *local* agent, so several agents
 *                    write into the same thread concurrently
 *
 * `suggestion` and `system` are derived entries (an agent proposing a canvas
 * change, the room narrating a canvas edit).
 *
 * New sources are added by extending `ThreadEntry` and registering a renderer
 * in `entryRenderers` (src/components/thread/ThreadEntryRow.tsx) — nothing else
 * in the UI needs to know about the new kind.
 */

export type ParticipantKind = "human" | "agent";

export interface Participant {
  id: string;
  name: string;
  kind: ParticipantKind;
  avatarUrl?: string;
  /** For agents: the participant whose machine runs this agent. */
  operatorId?: string;
}

/** A node on the tldraw canvas an entry is anchored to. */
export interface CanvasAnchor {
  nodeId: string;
  label: string;
}

export type UploadState = "idle" | "uploading" | "processing" | "error" | "done";

export interface ThreadAttachment {
  id: string;
  name: string;
  /** `image` renders a thumbnail, anything else renders an icon. */
  kind: "image" | "file";
  url?: string;
  /** Free-form caption, e.g. "PNG · 240 KB". */
  meta?: string;
  state?: UploadState;
}

interface ThreadEntryBase {
  id: string;
  /**
   * Monotonic per-room sequence, assigned by the server. This is the ordering
   * key: `at` is a display detail, and trusting it would reorder the stream
   * whenever a slow client's message lands after a later one.
   */
  seq: number;
  /** ISO 8601. Shown to the reader, never used to sort. */
  at: string;
  /** Participant id. For agent entries, the agent's own id. */
  authorId: string;
}

/** One line of call transcription, linked to whoever was speaking. */
export interface TranscriptEntry extends ThreadEntryBase {
  kind: "transcript";
  text: string;
  /** Set when an agent flagged this line as worth acting on. */
  trigger?: { label: string; confidence: number };
}

/** A message typed by a human participant. */
export interface MessageEntry extends ThreadEntryBase {
  kind: "message";
  text: string;
  /** Participant ids mentioned with `@`, highlighted in the body. */
  mentions?: string[];
  attachments?: ThreadAttachment[];
  anchors?: CanvasAnchor[];
  source?: "typed" | "transcript";
  replyToEntryId?: string;
}

/**
 * One action an agent took. `tool` is deliberately an open string so a new
 * agent capability shows up in the thread without a UI change.
 */
export interface AgentStep {
  id: string;
  tool: string;
  /** Present tense while running, past tense once it settles. */
  summary: string;
  /** Canvas node the step touched — makes the row jumpable. */
  target?: CanvasAnchor;
  state?: "pending" | "running" | "done" | "error";
  /** `performance.now()` at the first sighting, for the live duration. */
  startedAt?: number;
  durationMs?: number;
  /** Only set when `state` is `error`; shown on the row instead of a duration. */
  error?: string;
}

/** Output of one agent turn. */
export interface AgentEntry extends ThreadEntryBase {
  kind: "agent";
  text: string;
  /** e.g. "Claude" — shown as "via Claude". */
  model?: string;
  durationMs?: number;
  traceId?: string;
  steps?: AgentStep[];
  /**
   * The agent's current reasoning: the last finished sentence of what it has
   * streamed, cleared when the turn ends. One line on purpose, since a side
   * panel has no room for a full thought log.
   */
  thought?: string;
  /** The agent is reasoning, even if no whole sentence is ready to show yet. */
  thinking?: boolean;
  sources?: { kind: "entry" | "shape"; id: string }[];
  status?: "running" | "done" | "failed" | "cancelled";
  hidden?: boolean;
}

/** An agent proposing a canvas change, awaiting accept / dismiss. */
export interface SuggestionEntry extends ThreadEntryBase {
  kind: "suggestion";
  /** Entry this was derived from, so the UI can offer a jump. */
  sourceEntryId?: string;
  /** Human-readable provenance, e.g. "from marta's comment 10:42". */
  sourceLabel: string;
  quote: string;
  proposal: { type: string; label: string };
  text?: string;
  draft?: unknown;
  sources?: { kind: "entry" | "shape"; id: string }[];
  targetShapeId?: string;
  status?: "open" | "accepted" | "dismissed" | "outdated";
  resolvedBy?: string | null;
  /** Keyboard hint shown in the header, e.g. "⌘↵". */
  shortcut?: string;
}

export interface TriggerEntry extends ThreadEntryBase {
  kind: "trigger";
  triggerId: string;
  requestedBy: string;
  reason: string;
  mode: "act" | "context" | "propose";
  status: "pending" | "offered" | "running" | "needs_claim" | "done" | "failed" | "cancelled" | "expired";
  /** Shape ids the request was about — what the canvas highlights while it runs. */
  anchors: string[];
  assigneeSessionId: string | null;
  attempt: number;
}

export interface OfferEntry extends ThreadEntryBase {
  kind: "offer";
  triggerId: string;
  runId: string;
  title: string;
  request: string;
  text: string;
  sources: { kind: "entry" | "shape"; id: string }[];
  status: "open" | "accepted" | "dismissed" | "outdated";
  resolvedBy: string | null;
  resultTriggerId: string | null;
}

/** Room narration: canvas moves, joins, renames. */
export interface SystemEntry extends ThreadEntryBase {
  kind: "system";
  text: string;
}

export type ThreadEntry =
  | TranscriptEntry
  | MessageEntry
  | AgentEntry
  | SuggestionEntry
  | TriggerEntry
  | OfferEntry
  | SystemEntry;

export type ThreadEntryKind = ThreadEntry["kind"];

/* ------------------------------------------------------------------- search */

/**
 * Everything in an entry a reader could plausibly search for.
 *
 * This replaced a three-way kind filter (Everything / Messages / Agent
 * activity). The filter cost a permanent row in the panel header to answer a
 * question nobody asks; "where did we say that" is the question a thread that
 * records a whole meeting actually gets, and the tabs could not answer it.
 */
export function entrySearchText(entry: ThreadEntry): string {
  const parts: string[] = [];
  if ("text" in entry && entry.text) parts.push(entry.text);
  switch (entry.kind) {
    case "suggestion":
      parts.push(entry.sourceLabel, entry.quote, entry.proposal.label);
      break;
    case "trigger":
      parts.push(entry.reason, entry.status);
      break;
    case "offer":
      parts.push(entry.title, entry.request);
      break;
    case "message":
      for (const anchor of entry.anchors ?? []) parts.push(anchor.label);
      for (const attachment of entry.attachments ?? []) parts.push(attachment.name);
      break;
    case "agent":
      for (const step of entry.steps ?? []) parts.push(step.summary, step.tool);
      break;
  }
  return parts.join(" ").toLowerCase();
}

export function matchesSearch(entry: ThreadEntry, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return entrySearchText(entry).includes(needle);
}

/* ------------------------------------------------------------------ grouping */

/**
 * Render state the client owns and the server never sees.
 *
 * These four used to live on the entries themselves, which made `ThreadEntry`
 * disagree with the wire type for no good reason: the room has no opinion on
 * whether *this* client has acknowledged a message or how many agent steps
 * *this* reader has unfolded. Keeping them here means a wire entry can be
 * rendered as-is.
 */
export interface ThreadViewState {
  /** Sent from this client, not yet acknowledged by the room. */
  pendingIds?: ReadonlySet<string>;
  /** Agent turns whose tokens are still arriving. */
  streamingIds?: ReadonlySet<string>;
  /** Transcript lines the STT engine may still revise. */
  interimIds?: ReadonlySet<string>;
  /** Steps rendered before the "N more steps" fold. */
  visibleSteps?: number;
  /** Client insertion order for optimistic/local entries that have no server seq yet. */
  entryOrder?: ReadonlyMap<string, number>;
}

const noIds: ReadonlySet<string> = new Set();

/**
 * A row in the rendered stream. Consecutive transcript lines collapse into a
 * single `transcript-run` so a long stretch of call audio stays one foldable
 * block instead of flooding the thread.
 */
export type ThreadRow =
  | {
      type: "entry";
      id: string;
      entry: ThreadEntry;
      pending: boolean;
      streaming: boolean;
      visibleSteps: number;
    }
  | {
      type: "transcript-run";
      id: string;
      entries: TranscriptEntry[];
      interimIds: ReadonlySet<string>;
    };

export function buildThreadRows(
  entries: ThreadEntry[],
  search = "",
  view: ThreadViewState = {}
): ThreadRow[] {
  const pendingIds = view.pendingIds ?? noIds;
  const streamingIds = view.streamingIds ?? noIds;
  const interimIds = view.interimIds ?? noIds;
  const visibleSteps = view.visibleSteps ?? 2;
  const entryOrder = view.entryOrder;

  const rows: ThreadRow[] = [];

  // Sort before grouping: a transcript run is "consecutive lines", which is
  // only meaningful once the stream is actually in order. Local agent output
  // has no server sequence, so preserve the client's insertion order whenever
  // it is interleaved with server-numbered entries.
  const ordered = [...entries].sort((a, b) => {
    const aOrder = entryOrder?.get(a.id);
    const bOrder = entryOrder?.get(b.id);
    if (a.seq === PENDING_SEQ || b.seq === PENDING_SEQ) {
      if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
      if (aOrder !== undefined) return -1;
      if (bOrder !== undefined) return 1;
    }
    return a.seq - b.seq;
  });

  for (const entry of ordered) {
    // A running turn with no text used to be skipped, because an empty bubble
    // says nothing. It now carries the step rail, which is the one moment the
    // reader most wants it.
    if (entry.kind === "agent" && entry.hidden) continue;
    // Contextual and propose triggers are bookkeeping for a turn the reader
    // already sees as an agent entry. They were only ever visible behind the
    // deleted "Agent activity" tab; per-turn diagnostics cover that need now.
    if (entry.kind === "trigger" && (entry.mode === "context" || entry.mode === "propose")) continue;
    if (!matchesSearch(entry, search)) continue;

    if (entry.kind === "transcript") {
      const last = rows[rows.length - 1];
      if (last?.type === "transcript-run") {
        last.entries.push(entry);
        continue;
      }
      rows.push({
        type: "transcript-run",
        id: `run-${entry.id}`,
        entries: [entry],
        interimIds,
      });
      continue;
    }

    rows.push({
      type: "entry",
      id: entry.id,
      entry,
      pending: pendingIds.has(entry.id),
      streaming: streamingIds.has(entry.id),
      visibleSteps,
    });
  }

  return rows;
}

/**
 * Seq for an entry this client just created and the room has not numbered yet.
 * Sorting last is the honest position: it is the newest thing we know about.
 */
export const PENDING_SEQ = Number.MAX_SAFE_INTEGER;

/* ------------------------------------------------------------- participants */

export type ParticipantMap = Record<string, Participant>;

export function toParticipantMap(participants: Participant[]): ParticipantMap {
  return Object.fromEntries(participants.map((p) => [p.id, p]));
}

/** Falls back to a placeholder so an unknown author never breaks a render. */
export function participantOf(
  participants: ParticipantMap,
  id: string
): Participant {
  return participants[id] ?? { id, name: id, kind: "human" };
}

/* -------------------------------------------------------------- formatting */

export function formatTime(at: string, withSeconds = false) {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
    hour12: false,
  });
}

export function formatDuration(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Splits a body into plain text and `@mention` tokens so mentions can be
 * highlighted without dangerouslySetInnerHTML.
 */
export function splitMentions(text: string) {
  return text
    .split(/(@[\w-]+)/g)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("@")
        ? ({ type: "mention", value: part } as const)
        : ({ type: "text", value: part } as const)
    );
}
