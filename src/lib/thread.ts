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
  /** ISO 8601. Ordering key for the merged stream. */
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
  /** Still being revised by the STT engine. */
  interim?: boolean;
}

/** A message typed by a human participant. */
export interface MessageEntry extends ThreadEntryBase {
  kind: "message";
  text: string;
  /** Participant ids mentioned with `@`, highlighted in the body. */
  mentions?: string[];
  attachments?: ThreadAttachment[];
  anchors?: CanvasAnchor[];
  /** Optimistically rendered, not yet acknowledged by the room. */
  pending?: boolean;
}

/**
 * One action an agent took. `tool` is deliberately an open string so a new
 * agent capability shows up in the thread without a UI change.
 */
export interface AgentStep {
  id: string;
  tool: string;
  summary: string;
  /** Canvas node the step touched — makes the row jumpable. */
  target?: CanvasAnchor;
  state?: "running" | "done" | "error";
}

/** Output of one agent turn. */
export interface AgentEntry extends ThreadEntryBase {
  kind: "agent";
  text: string;
  /** e.g. "Claude" — shown as "via Claude". */
  model?: string;
  durationMs?: number;
  steps?: AgentStep[];
  /** Steps rendered before the "N more steps" toggle. Defaults to 2. */
  visibleSteps?: number;
  /** Tokens still arriving; the body shimmers and the scroller follows it. */
  streaming?: boolean;
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
  /** Keyboard hint shown in the header, e.g. "⌘↵". */
  shortcut?: string;
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
  | SystemEntry;

export type ThreadEntryKind = ThreadEntry["kind"];

/* ------------------------------------------------------------------ filters */

export type ThreadFilter = "everything" | "messages" | "agent";

const filterKinds: Record<ThreadFilter, ThreadEntryKind[] | null> = {
  everything: null,
  messages: ["transcript", "message"],
  agent: ["agent", "suggestion"],
};

export function matchesFilter(entry: ThreadEntry, filter: ThreadFilter) {
  const kinds = filterKinds[filter];
  return kinds === null || kinds.includes(entry.kind);
}

/* ------------------------------------------------------------------ grouping */

/**
 * A row in the rendered stream. Consecutive transcript lines collapse into a
 * single `transcript-run` so a long stretch of call audio stays one foldable
 * block instead of flooding the thread.
 */
export type ThreadRow =
  | { type: "entry"; id: string; entry: ThreadEntry }
  | { type: "transcript-run"; id: string; entries: TranscriptEntry[] };

export function buildThreadRows(
  entries: ThreadEntry[],
  filter: ThreadFilter = "everything"
): ThreadRow[] {
  const rows: ThreadRow[] = [];

  for (const entry of entries) {
    if (!matchesFilter(entry, filter)) continue;

    if (entry.kind === "transcript") {
      const last = rows[rows.length - 1];
      if (last?.type === "transcript-run") {
        last.entries.push(entry);
        continue;
      }
      rows.push({ type: "transcript-run", id: `run-${entry.id}`, entries: [entry] });
      continue;
    }

    rows.push({ type: "entry", id: entry.id, entry });
  }

  return rows;
}

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
