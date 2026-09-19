/**
 * The seam between the thread UI and wherever entries actually come from.
 *
 * `ThreadPanel` has always been transport agnostic (entries in, callbacks out),
 * but `ChatPanel` held the room in a `useState(demoEntries)` and appended to it
 * directly, so there was nowhere for the room server to plug in. This is that
 * nowhere, made explicit: the fixtures become one implementation and
 * `createWsTransport(roomId)` becomes another, and the panel cannot tell them
 * apart.
 *
 * The wire type lives in `@kan/protocol` and is owned by the server. Nothing
 * here may widen it — `toViewEntry` is the only place the two vocabularies
 * meet.
 */
import type { Entry, NodeDraft } from "@kan/protocol";
import { EventsServerMessage } from "@kan/protocol";
import {
  createSocketTicket,
  getServerEvents,
  getRoomWebSocketUrl,
  postServerMessage,
  resolveServerSuggestion,
  uploadServerAsset,
} from "./api-client";

import type { AgentStep, CanvasAnchor, ThreadEntry } from "./thread";

export interface SendInput {
  /**
   * Client-minted id. The server's `POST /rooms/:id/messages` is idempotent by
   * this id, so a retry after a dropped response cannot double-post, and the
   * echo carries it back so the sender can match its optimistic copy.
   */
  id: string;
  text: string;
  /** Shape ids of the current canvas selection. */
  anchors: string[];
  files: File[];
}

export interface RoomTransport {
  /** Fires on every append and on the `since=<seq>` replay after a reconnect. */
  subscribe(onEntry: (entry: ThreadEntry) => void): () => void;
  send(input: SendInput): Promise<void>;
  resolveSuggestion(entryId: string, accepted: boolean): Promise<void>;
  claimTrigger(triggerId: string): Promise<boolean>;
}

/* ----------------------------------------------------------- wire -> view */

/** Anchors arrive as bare shape ids; labels are resolved from the canvas. */
function toAnchors(shapeIds: string[]): CanvasAnchor[] {
  return shapeIds.map((id) => ({ nodeId: id, label: id.replace(/^shape:/, "") }));
}

/** Agent steps are bounded JSON on the wire, so narrow defensively. */
function toSteps(steps: unknown[]): AgentStep[] {
  return steps.flatMap((raw, i) => {
    if (typeof raw !== "object" || raw === null) return [];
    const step = raw as Record<string, unknown>;
    return [
      {
        id: typeof step.id === "string" ? step.id : `step-${i}`,
        tool: typeof step.tool === "string" ? step.tool : "tool",
        summary: typeof step.summary === "string" ? step.summary : "",
        state:
          step.state === "running" || step.state === "error" ? step.state : "done",
      },
    ];
  });
}

function draftLabel(draft: NodeDraft): string {
  return draft.type === "concept" ? draft.label : draft.title;
}

/**
 * Maps one wire entry onto the row model the thread renders.
 *
 * `trigger` returns null on purpose: a trigger is a real entry the whole room
 * sees, but the panel has no renderer for it yet, and dropping it here is
 * honest about that. Voice has no wire kind at all yet, so `transcript` view
 * entries only ever come from fixtures.
 */
export function toViewEntry(entry: Entry): ThreadEntry | null {
  const base = { id: entry.id, seq: entry.seq, at: entry.at };

  switch (entry.kind) {
    case "message":
      return {
        ...base,
        kind: "message",
        authorId: entry.authorId,
        text: entry.text,
        anchors: toAnchors(entry.anchors),
      };

    case "system":
      return { ...base, kind: "system", authorId: entry.authorId, text: entry.text };

    case "agent_turn":
      return {
        ...base,
        kind: "agent",
        authorId: entry.agentId,
        text: entry.text,
        steps: toSteps(entry.steps),
      };

    case "suggestion":
      return {
        ...base,
        kind: "suggestion",
        authorId: entry.runId,
        sourceLabel: `from trigger ${entry.triggerId.slice(0, 8)}`,
        quote: draftLabel(entry.draft),
        proposal: { type: entry.draft.type, label: draftLabel(entry.draft) },
      };

    case "trigger":
      return null;
  }
}

export function toViewEntries(entries: Entry[]): ThreadEntry[] {
  return entries.flatMap((entry) => {
    const view = toViewEntry(entry);
    return view ? [view] : [];
  });
}

export function createWsTransport(roomId: string): RoomTransport {
  const listeners = new Set<(entry: ThreadEntry) => void>();
  let socket: WebSocket | null = null;
  let cursor = 0;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let replaying = false;

  const emit = (entry: Entry) => {
    const view = toViewEntry(entry);
    if (view) for (const listener of listeners) listener(view);
  };

  const connect = async () => {
    if (stopped || socket) return;
    try {
      const { ticket } = await createSocketTicket(roomId, "events");
      if (stopped) return;
      const ws = new WebSocket(getRoomWebSocketUrl(roomId, "events", ticket, cursor));
      socket = ws;
      ws.onmessage = (event) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = EventsServerMessage.safeParse(raw);
        if (!parsed.success) return;
        if (parsed.data.type === "event") {
          cursor = Math.max(cursor, parsed.data.event.cursor);
          emit(parsed.data.event.entry);
        } else if (parsed.data.type === "ready") {
          cursor = Math.max(cursor, parsed.data.cursor);
        }
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
        if (!stopped) retryTimer = setTimeout(() => void connect(), 1000);
      };
      ws.onerror = () => ws.close();
    } catch {
      if (!stopped) retryTimer = setTimeout(() => void connect(), 1000);
    }
  };

  const replay = async () => {
    if (stopped || replaying) return;
    replaying = true;
    try {
      let page;
      do {
        page = await getServerEvents(roomId, cursor);
        for (const event of page.events) {
          cursor = Math.max(cursor, event.cursor);
          emit(event.entry);
        }
      } while (!stopped && page.hasMore);
    } catch {
      // The websocket may still be healthy; the next poll retries replay.
    } finally {
      replaying = false;
    }
  };

  return {
    subscribe(onEntry) {
      stopped = false;
      listeners.add(onEntry);
      void replay();
      void connect();
      if (!pollTimer) pollTimer = setInterval(() => void replay(), 2000);
      return () => {
        listeners.delete(onEntry);
        if (listeners.size === 0) {
          stopped = true;
          if (retryTimer) clearTimeout(retryTimer);
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          socket?.close();
          socket = null;
        }
      };
    },
    async send({ id, text, anchors, files }) {
      const attachments: string[] = [];
      for (const file of files) {
        const uploaded = await uploadServerAsset(file, file.type || "application/octet-stream");
        attachments.push(uploaded.id);
      }
      await postServerMessage(roomId, { id, text, anchors, attachments });
    },
    async resolveSuggestion(entryId, accepted) {
      await resolveServerSuggestion(roomId, entryId, accepted);
    },
    async claimTrigger() {
      return false;
    },
  };
}
