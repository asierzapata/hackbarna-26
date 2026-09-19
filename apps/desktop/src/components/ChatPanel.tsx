import * as React from "react";

import { ConversationSimulator, ThreadPanel } from "./thread";
import { Button } from "./ui/button";
import { useAgent, type AgentToolCall } from "./agent-context";
import { useCanvas } from "./canvas-context";
import type {
  AgentEntry,
  AgentStep,
  SuggestionEntry,
  ThreadEntry,
} from "@/lib/thread";
import { PENDING_SEQ } from "@/lib/thread";
import { createWsTransport, type RoomTransport } from "@/lib/room-transport";
import { createMockTransport, demoParticipants } from "@/lib/thread-fixtures";
import { hackathonConversation, type ConversationLine } from "@/lib/conversation-script";

import { getInstallationProfile } from "@/lib/installation-profile";
import { type AiModelSelection } from "@/components/ui/ai-model-select";
import { buildCanvasPrompt, executeCanvasTool, shouldActOnLine } from "@/lib/canvas-agent";
import { createCanvasTools } from "@/nodes/tools";

const DEFAULT_USER = "You";
const AGENT = "assistant";

/** ACP tool statuses, in the thread's vocabulary. */
const stepStates: Record<string, AgentStep["state"]> = {
  pending: "running",
  in_progress: "running",
  completed: "done",
  failed: "error",
};

export function ChatReopenButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="chat-reopen-button shadow-md"
      onClick={onClick}
    >
      Open chat
    </Button>
  );
}

/** Folds a tool call into the step list, in place if we have seen its id. */
function mergeStep(steps: AgentStep[], call: AgentToolCall): AgentStep[] {
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
  online = false,
  onClose,
}: {
  roomId?: string;
  online?: boolean;
  onClose?: () => void;
}) {
  const agent = useAgent();
  const { editor, jumpToNode, selectedAnchors, shapeCount, labelForNode } = useCanvas();
  const canvasTools = React.useMemo(() => editor && !online ? createCanvasTools(editor) : null, [editor, online]);
  const transcript = React.useRef<ConversationLine[]>([]);
  const cancelRef = React.useRef(agent.cancel);
  cancelRef.current = agent.cancel;
  React.useEffect(() => () => { void cancelRef.current(); }, [roomId]);

  const transport = React.useMemo<RoomTransport>(
    () => (online && roomId ? createWsTransport(roomId) : createMockTransport()),
    [online, roomId]
  );

  const [entries, setEntries] = React.useState<ThreadEntry[]>([]);
  const [pendingIds, setPendingIds] = React.useState<ReadonlySet<string>>(
    new Set()
  );
  const [streamingIds, setStreamingIds] = React.useState<ReadonlySet<string>>(
    new Set()
  );
  const [micActive, setMicActive] = React.useState(false);
  const models = agent.status.models?.available ?? [];
  const modelSelection: AiModelSelection = { id: agent.status.models?.current ?? "" };

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

  /**
   * Feeds one line of a scripted conversation into the thread as a transcript
   * entry, the way live call transcription would once it exists. Carries
   * `PENDING_SEQ` for the same reason `askAgent` does: nothing has numbered
   * it, and voice has no wire kind yet (see `room-transport.ts`).
   */
  async function simulateLine(line: ConversationLine, index: number) {
    if (index === 0) transcript.current = [];
    transcript.current.push(line);
    upsert({
      id: crypto.randomUUID(),
      seq: PENDING_SEQ,
      kind: "transcript",
      at: new Date().toISOString(),
      authorId: line.speaker,
      text: line.text,
      trigger: line.trigger,
    });
    if (shouldActOnLine(line)) {
      if (!canvasTools || agent.status.state !== "ready") throw new Error("Connect Devin on an offline canvas before running this conversation.");
      await askAgent(line.text, modelSelection, [...transcript.current]);
    }
  }

  /** Patches one agent entry in place while its turn streams. */
  function patchAgent(id: string, fn: (entry: AgentEntry) => AgentEntry) {
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === id && entry.kind === "agent" ? fn(entry) : entry
      )
    );
  }

  /**
   * One prompt turn against the host's agent. Text arrives in chunks, so the
   * entry is appended empty and filled as it streams.
   *
   * These turns are local: the agent runs on this machine, and until the room
   * server exists there is nowhere to publish them. They carry `PENDING_SEQ`
   * so they sort after everything the room has numbered.
   */
  async function askAgent(
    text: string,
    selectedModel: AiModelSelection,
    context: ConversationLine[] = [],
  ) {
    const id = `agent-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const model = models.find((item) => item.id === selectedModel.id);

    upsert({
      id,
      seq: PENDING_SEQ,
      kind: "agent",
      at: new Date().toISOString(),
      authorId: AGENT,
      model: model?.label ?? agent.status.agent ?? agent.status.providerLabel ?? "Agent",
      text: "",
    });
    setStreamingIds((prev) => new Set(prev).add(id));

    try {
      const shapeIds = context.length ? [] : selectedAnchors.map((anchor) => anchor.nodeId);
      await agent.prompt(canvasTools ? buildCanvasPrompt(text, context, shapeIds) : text, {
        canvas: canvasTools && roomId ? {
          id: roomId,
          shapeIds,
          execute: (name, input) => {
            const result = executeCanvasTool(canvasTools, name, name === "addNode" ? {
              ...(input as object),
              provenance: { entryId: id, runId: id, agentId: AGENT, byUserId: userId },
            } : input);
            return result;
          },
        } : undefined,
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
        text: `${entry.text}${entry.text ? "\n\n" : ""}The agent could not complete this turn: ${error}`,
      }));
      throw error;
    } finally {
      setStreamingIds((prev) => withoutId(prev, id));
      patchAgent(id, (entry) => ({ ...entry, durationMs: Date.now() - startedAt }));
    }
  }

  const [userName, setUserName] = React.useState(DEFAULT_USER);
  const [userId, setUserId] = React.useState(DEFAULT_USER);

  React.useEffect(() => {
    void getInstallationProfile().then((p) => {
      if (p?.name) {
        setUserName(p.name);
        setUserId(p.installationId);
      }
    });
  }, []);

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
      authorId: userId,
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

    // A connected agent answers every message; until then the thread is local.
    if (agent.status.state === "ready") void askAgent(text, modelSelection).catch(() => {});
  }

  function resolveSuggestion(suggestion: SuggestionEntry, accepted: boolean) {
    setEntries((prev) => prev.filter((entry) => entry.id !== suggestion.id));
    void transport.resolveSuggestion(suggestion.id, accepted);
  }

  const participants = React.useMemo(() => {
    return [
      { id: userId, name: userName, kind: "human" as const },
      ...demoParticipants.filter((p) => p.id !== "asier"),
      ...hackathonConversation.participants.map((participant) => ({ ...participant, kind: "human" as const })),
    ];
  }, [userId, userName]);

  const view = React.useMemo(
    () => ({ pendingIds, streamingIds }),
    [pendingIds, streamingIds]
  );

  return (
    <ThreadPanel
      channel={roomId ? `room/${roomId.slice(0, 8)}` : "#feature-kickoff"}
      entries={entries}
      participants={participants}
      currentUserId={userId}
      anchors={selectedAnchors}
      canvasNodeCount={shapeCount}
      view={view}
      toolbar={
        <ConversationSimulator
          script={hackathonConversation}
          onLine={simulateLine}
          disabled={agent.status.state !== "ready" || !canvasTools || agent.busy}
          onStop={() => void agent.cancel()}
        />
      }
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
        disabled: agent.busy,
        modelSelection: models.length ? modelSelection : undefined,
        models,
        modelDisabled: agent.busy || agent.status.state !== "ready",
        onModelSelectionChange: (selection) => { void agent.setModel(selection.id); },
      }}
    />
  );
}
