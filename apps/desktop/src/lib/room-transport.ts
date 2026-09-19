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
import type { Entry, ExecutorPresence, Lease, NodeDraft, Room, User } from "@kan/protocol";
import { EventsServerMessage } from "@kan/protocol";
import {
  cancelServerTrigger,
  claimServerTrigger,
  createSocketTicket,
  getRoomWebSocketUrl,
  postServerMessage,
  retryServerTrigger,
  resolveServerOffer,
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
  source?: "typed" | "transcript";
  replyToEntryId?: string;
}

export interface RoomSnapshot {
  connected: boolean;
  ready: boolean;
  sessionId: string | null;
  room?: Room;
  members: User[];
  executors: ExecutorPresence[];
  triggers: import("@kan/protocol").Trigger[];
  error?: string;
}

export interface RoomTransport {
  /** Fires on every authoritative websocket event and ready snapshot. */
  subscribe(onEntry: (entry: ThreadEntry) => void, onSnapshot?: (snapshot: RoomSnapshot) => void): () => void;
  send(input: SendInput): Promise<void>;
  resolveSuggestion(entryId: string, accepted: boolean): Promise<void>;
  resolveOffer(entryId: string, accepted: boolean): Promise<void>;
  cancelTrigger(triggerId: string): Promise<void>;
  retryTrigger(triggerId: string): Promise<void>;
  claimTrigger(triggerId: string): Promise<Lease | null>;
  setExecutorReady(ready: boolean, agentId: string, scope: "own" | "room" | "manual", background: boolean): void;
  snapshot(): RoomSnapshot;
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
 * Voice has no wire kind at all yet, so `transcript` view entries only ever
 * come from fixtures — everything else the room can say has a case here.
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
        source: entry.source,
        replyToEntryId: entry.replyToEntryId,
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
        sources: entry.sources,
        status: entry.status,
        hidden: entry.hidden,
      };

    case "suggestion":
      return {
        ...base,
        kind: "suggestion",
        authorId: entry.runId,
        sourceLabel: `from trigger ${entry.triggerId.slice(0, 8)}`,
        quote: entry.text ?? draftLabel(entry.draft),
        proposal: { type: entry.draft.type, label: draftLabel(entry.draft) },
        text: entry.text,
        draft: entry.draft,
        sources: entry.sources,
        targetShapeId: entry.targetShapeId,
        status: entry.status,
        resolvedBy: entry.resolvedBy,
      };

    case "trigger":
      return {
        ...base,
        kind: "trigger",
        authorId: entry.trigger.requestedBy,
        triggerId: entry.trigger.id,
        requestedBy: entry.trigger.requestedBy,
        reason: entry.trigger.reason,
        mode: entry.trigger.mode,
        status: entry.trigger.status,
        anchors: entry.trigger.anchors,
        assigneeSessionId: entry.trigger.assigneeSessionId,
        attempt: entry.trigger.attempt,
      };

    case "offer":
      return {
        ...base,
        kind: "offer",
        authorId: entry.runId,
        triggerId: entry.triggerId,
        runId: entry.runId,
        title: entry.title,
        request: entry.request,
        text: entry.text,
        sources: entry.sources,
        status: entry.status,
        resolvedBy: entry.resolvedBy,
        resultTriggerId: entry.resultTriggerId,
      };
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
  const snapshotListeners = new Set<(snapshot: RoomSnapshot) => void>();
  let socket: WebSocket | null = null;
  let cursor = 0;
  let sessionId: string | null = null;
  let ready = false;
  let epoch = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let currentSnapshot: RoomSnapshot = { connected: false, ready: false, sessionId: null, members: [], executors: [], triggers: [] };
  const preReady: Entry[] = [];
  let readiness: { ready: boolean; agentId: string; scope: "own" | "room" | "manual"; background: boolean } | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = (entry: Entry) => {
    const view = toViewEntry(entry);
    if (view) for (const listener of listeners) listener(view);
  };

  const publishSnapshot = (snapshot: RoomSnapshot) => { currentSnapshot = snapshot; for (const listener of snapshotListeners) listener(snapshot); };
  const sendReady = (ws: WebSocket) => {
    if (readiness && ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "executor.ready", ...readiness }));
  };

  const connect = async () => {
    if (stopped || socket) return;
    const connectEpoch = ++epoch;
    try {
      const { ticket } = await createSocketTicket(roomId, "events");
      if (stopped || connectEpoch !== epoch) return;
      const ws = new WebSocket(getRoomWebSocketUrl(roomId, "events", ticket, cursor));
      socket = ws;
      ws.onopen = () => sendReady(ws);
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
          if (parsed.data.event.entry.kind === "trigger") {
            const next = parsed.data.event.entry.trigger;
            publishSnapshot({ ...currentSnapshot, triggers: [...currentSnapshot.triggers.filter((trigger) => trigger.id !== next.id), next] });
          }
          if (ready) emit(parsed.data.event.entry); else preReady.push(parsed.data.event.entry);
        } else if (parsed.data.type === "ready") {
          cursor = Math.max(cursor, parsed.data.cursor);
          sessionId = parsed.data.sessionId;
          ready = true;
          publishSnapshot({ connected: true, ready: true, sessionId, room: parsed.data.room, members: parsed.data.members, executors: parsed.data.executors, triggers: parsed.data.triggers });
          sendReady(ws);
          heartbeatTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "heartbeat" })); }, 10_000);
          for (const entry of preReady.splice(0)) emit(entry);
        } else if (parsed.data.type === "presence") {
          publishSnapshot({ connected: true, ready, sessionId, room: parsed.data.room, members: parsed.data.members, executors: parsed.data.executors, triggers: currentSnapshot.triggers });
        }
      };
      ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        sessionId = null;
        ready = false;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        publishSnapshot({ connected: false, ready: false, sessionId: null, members: [], executors: [], triggers: [] });
        if (!stopped) retryTimer = setTimeout(() => void connect(), 1000);
      };
      ws.onerror = () => ws.close();
    } catch {
      if (!stopped) retryTimer = setTimeout(() => void connect(), 1000);
    }
  };

  return {
    subscribe(onEntry, onSnapshot) {
      stopped = false;
      listeners.add(onEntry);
      if (onSnapshot) snapshotListeners.add(onSnapshot);
      void connect();
      return () => {
        listeners.delete(onEntry);
        if (onSnapshot) snapshotListeners.delete(onSnapshot);
        if (listeners.size === 0) {
          stopped = true;
          epoch += 1;
          if (retryTimer) clearTimeout(retryTimer);
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          socket?.close();
          socket = null;
          sessionId = null;
          ready = false;
        }
      };
    },
    async send({ id, text, anchors, files, source, replyToEntryId }) {
      const attachments: string[] = [];
      for (const file of files) {
        const uploaded = await uploadServerAsset(file, file.type || "application/octet-stream");
        attachments.push(uploaded.id);
      }
      await postServerMessage(roomId, { id, text, anchors, attachments, source, replyToEntryId });
    },
    async resolveSuggestion(entryId, accepted) {
      await resolveServerSuggestion(roomId, entryId, accepted);
    },
    async resolveOffer(entryId, accepted) {
      await resolveServerOffer(roomId, entryId, accepted);
    },
    async cancelTrigger(triggerId) {
      await cancelServerTrigger(roomId, triggerId);
    },
    async retryTrigger(triggerId) {
      await retryServerTrigger(roomId, triggerId, crypto.randomUUID());
    },
    async claimTrigger(triggerId) {
      if (!sessionId) return null;
      const { lease } = await claimServerTrigger(roomId, triggerId, sessionId, true);
      return lease;
    },
    setExecutorReady(ready, agentId, scope, background) {
      readiness = { ready, agentId, scope, background };
      if (socket) sendReady(socket);
    },
    snapshot() { return currentSnapshot; },
  };
}
