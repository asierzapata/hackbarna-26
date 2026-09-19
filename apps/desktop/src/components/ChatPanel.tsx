import * as React from "react";

import { ThreadPanel } from "./thread";
import { useDevin, type DevinToolCall } from "./devin-context";
import { useCanvas } from "./canvas-context";
import type {
  AgentEntry,
  AgentStep,
  SuggestionEntry,
  ThreadEntry,
} from "@/lib/thread";
import { PENDING_SEQ } from "@/lib/thread";
import type { RoomTransport } from "@/lib/room-transport";
import { createMockTransport, demoParticipants } from "@/lib/thread-fixtures";

const CURRENT_USER = "asier";
const AGENT = "assistant";

/** ACP tool statuses, in the thread's vocabulary. */
const stepStates: Record<string, AgentStep["state"]> = {
  pending: "running",
  in_progress: "running",
  completed: "done",
  failed: "error",
};

/** Folds a tool call into the step list, in place if we have seen its id. */
function mergeStep(steps: AgentStep[], call: DevinToolCall): AgentStep[] {
  const index = steps.findIndex((step) => step.id === call.id);
  const previous = index === -1 ? undefined : steps[index];
  const step: AgentStep = {
    id: call.id,
    tool: call.kind ?? previous?.tool ?? "tool",
    summary: call.title ?? previous?.summary ?? call.status,
    state: stepStates[call.status] ?? "running",
  };
  if (index === -1) return [...steps, step];
  return steps.map((existing, i) => (i === index ? step : existing));
}

function withoutId(ids: ReadonlySet<string>, id: string) {
  const next = new Set(ids);
  next.delete(id);
  return next;
}

/**
 * Binds one room to the thread panel.
 *
 * Everything the room knows arrives through `RoomTransport`; everything only
 * this client knows (what is unacknowledged, what is still streaming) stays in
 * `view` and never touches an entry. Swapping the mock for the real transport
 * is the one-line change at the top of this component.
 */
export function ChatPanel({
  roomId,
  onClose,
}: {
  roomId?: string;
  onClose?: () => void;
}) {
  const devin = useDevin();
  const { jumpToNode, selectedAnchors, shapeCount, labelForNode } = useCanvas();

  const transport = React.useMemo<RoomTransport>(
    // `createWsTransport(roomId)` goes here once the room server is up.
    () => createMockTransport(),
    []
  );

  const [entries, setEntries] = React.useState<ThreadEntry[]>([]);
  const [pendingIds, setPendingIds] = React.useState<ReadonlySet<string>>(
    new Set()
  );
  const [streamingIds, setStreamingIds] = React.useState<ReadonlySet<string>>(
    new Set()
  );
  const [micActive, setMicActive] = React.useState(false);

  /** Upsert by id: a replay and a live append are the same operation. */
  const upsert = React.useCallback((entry: ThreadEntry) => {
    setEntries((prev) => {
      const index = prev.findIndex((existing) => existing.id === entry.id);
      if (index === -1) return [...prev, entry];
      return prev.map((existing, i) => (i === index ? entry : existing));
    });
  }, []);

  React.useEffect(() => {
    return transport.subscribe((entry) => {
      upsert(entry);
      // The room numbered it, so our optimistic copy is now the real thing.
      setPendingIds((prev) => withoutId(prev, entry.id));
    });
  }, [transport, upsert]);

  /** Patches one agent entry in place while its turn streams. */
  function patchAgent(id: string, fn: (entry: AgentEntry) => AgentEntry) {
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === id && entry.kind === "agent" ? fn(entry) : entry
      )
    );
  }

  /**
   * One prompt turn against the host's Devin. Text arrives in chunks, so the
   * entry is appended empty and filled as it streams.
   *
   * These turns are local: the agent runs on this machine, and until the room
   * server exists there is nowhere to publish them. They carry `PENDING_SEQ`
   * so they sort after everything the room has numbered.
   */
  async function askDevin(text: string) {
    const id = `devin-${Date.now()}`;
    const startedAt = Date.now();

    upsert({
      id,
      seq: PENDING_SEQ,
      kind: "agent",
      at: new Date().toISOString(),
      authorId: AGENT,
      model: devin.status.agent ?? "Devin",
      text: "",
    });
    setStreamingIds((prev) => new Set(prev).add(id));

    try {
      await devin.prompt(text, {
        onText: (chunk) =>
          patchAgent(id, (entry) => ({ ...entry, text: entry.text + chunk })),
        onTool: (call) =>
          patchAgent(id, (entry) => ({
            ...entry,
            steps: mergeStep(entry.steps ?? [], call),
          })),
      });
    } catch (error) {
      patchAgent(id, (entry) => ({
        ...entry,
        text: entry.text || `Devin could not answer: ${error}`,
      }));
    } finally {
      setStreamingIds((prev) => withoutId(prev, id));
      patchAgent(id, (entry) => ({ ...entry, durationMs: Date.now() - startedAt }));
    }
  }

  function handleSend({ text, files }: { text: string; files: File[] }) {
    const id = crypto.randomUUID();
    const anchors = selectedAnchors;

    // Render it immediately, dimmed, and let the echo settle it. The room is
    // the thing that decides an entry exists; this is just a good guess.
    upsert({
      id,
      seq: PENDING_SEQ,
      kind: "message",
      at: new Date().toISOString(),
      authorId: CURRENT_USER,
      text,
      anchors,
    });
    setPendingIds((prev) => new Set(prev).add(id));

    void transport.send({
      id,
      text,
      anchors: anchors.map((anchor) => anchor.nodeId),
      files,
    });

    // Connected Devin answers every message; until then the thread is local.
    if (devin.status.state === "ready") void askDevin(text);
  }

  function resolveSuggestion(suggestion: SuggestionEntry, accepted: boolean) {
    setEntries((prev) => prev.filter((entry) => entry.id !== suggestion.id));
    void transport.resolveSuggestion(suggestion.id, accepted);
  }

  const view = React.useMemo(
    () => ({ pendingIds, streamingIds }),
    [pendingIds, streamingIds]
  );

  return (
    <ThreadPanel
      channel={roomId ? `room/${roomId.slice(0, 8)}` : "#feature-kickoff"}
      entries={entries}
      participants={demoParticipants}
      currentUserId={CURRENT_USER}
      anchors={selectedAnchors}
      canvasNodeCount={shapeCount}
      view={view}
      onClose={onClose}
      onCopyLink={() => navigator.clipboard?.writeText(window.location.href)}
      onJumpToNode={jumpToNode}
      resolveAnchorLabel={labelForNode}
      onAcceptSuggestion={(suggestion) => resolveSuggestion(suggestion, true)}
      onDismissSuggestion={(suggestion) => resolveSuggestion(suggestion, false)}
      composer={{
        onSend: handleSend,
        micActive,
        onToggleMic: () => setMicActive((on) => !on),
        disabled: devin.busy,
      }}
    />
  );
}
