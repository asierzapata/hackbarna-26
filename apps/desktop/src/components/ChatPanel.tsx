import * as React from "react";

import { ConversationSimulator, ThreadPanel } from "./thread";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

import { getServerRunContext, heartbeatServerRun, patchServerRoom, patchServerRun, completeServerRun } from "@/lib/api-client";
import { useCanvas } from "./canvas-context";
import { assistantCanvasRecords, applyAssistantOperations } from "@/lib/assistant-canvas";
import type { AgentEntry, AgentStep, OfferEntry, SuggestionEntry, ThreadEntry, TriggerEntry } from "@/lib/thread";
import { PENDING_SEQ } from "@/lib/thread";
import { createWsTransport, type RoomTransport } from "@/lib/room-transport";

import { createLocalTransport, type LocalTransport } from "@/lib/local-transport";
import { useAgent, type AgentToolCall } from "./agent-context";
import { runAssistantTurn, startLeaseExecution, type LeaseExecution } from "@/lib/assistant-controller";
import { hackathonConversation, type ConversationLine } from "@/lib/conversation-script";

import { getInstallationProfile } from "@/lib/installation-profile";
import { type AiModelSelection } from "@/components/ui/ai-model-select";
import { buildCanvasPrompt, executeCanvasTool, shouldActOnLine } from "@/lib/canvas-agent";
import { createCanvasTools } from "@/nodes/tools";
import { useQaSource } from "@/lib/qa-source";

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
  className,
}: {
  roomId?: string;
  online?: boolean;
  onClose?: () => void;
  className?: string;
}) {
  const agent = useAgent();
  const { editor, jumpToNode, selectedAnchors, shapeCount, labelForNode } = useCanvas();
  const canvasTools = React.useMemo(() => editor && !online ? createCanvasTools(editor) : null, [editor, online]);
  const transcript = React.useRef<ConversationLine[]>([]);
  const cancelRef = React.useRef(agent.cancel);
  cancelRef.current = agent.cancel;
  React.useEffect(() => () => { void cancelRef.current(); }, [roomId]);
  const [userName, setUserName] = React.useState(DEFAULT_USER);
  const [userId, setUserId] = React.useState(DEFAULT_USER);
  const [assistantScope, setAssistantScope] = React.useState<"own" | "room" | "manual">("own");
  const [backgroundChecks, setBackgroundChecks] = React.useState(false);
  const [assistantPaused, setAssistantPaused] = React.useState(false);

  const editorRef = React.useRef(editor);
  editorRef.current = editor;
  const userIdRef = React.useRef(userId);
  userIdRef.current = userId;
  const fallbackCanvasId = React.useRef(crypto.randomUUID());
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [leaseRevision, setLeaseRevision] = React.useState(0);
  const claiming = React.useRef(false);
  const reportError = React.useCallback((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)), []);

  const transport = React.useMemo<RoomTransport>(() => {
    if (online && roomId) return createWsTransport(roomId);
    return createLocalTransport({
      canvasId: roomId ?? fallbackCanvasId.current,
      get userId() { return userIdRef.current; },
      getCanvas: () => assistantCanvasRecords(editorRef.current).map((shape) => ({ ...shape, props: { ...shape.props } })),
      applyOperations: (operations, provenance) => {
        if (!editorRef.current) throw new Error("The canvas is not ready");
        return applyAssistantOperations(editorRef.current, operations, provenance);
      },
    });
  }, [online, roomId]);

  const [entries, setEntries] = React.useState<ThreadEntry[]>([]);
  const entryOrderRef = React.useRef(new Map<string, number>());
  const nextEntryOrderRef = React.useRef(0);
  const [pendingIds, setPendingIds] = React.useState<ReadonlySet<string>>(
    new Set()
  );
  const [streamingIds, setStreamingIds] = React.useState<ReadonlySet<string>>(
    new Set()
  );
  useQaSource("chat", () => ({
    roomId, online, entries, pendingIds: [...pendingIds], streamingIds: [...streamingIds],
    transcript: transcript.current,
  }));
  const models = agent.status.models?.available ?? [];
  const modelSelection: AiModelSelection = { id: agent.status.models?.current ?? "" };
  const [roomSnapshot, setRoomSnapshot] = React.useState(() => transport.snapshot());
  const activeLease = React.useRef<LeaseExecution | undefined>(undefined);
  const attempts = React.useRef(new Set<string>());
  React.useEffect(() => {
    const saved = roomId ? localStorage.getItem(`kan-assistant:${roomId}`) : null;
    if (!saved) return;
    try {
      const value = JSON.parse(saved) as { scope?: "own" | "room" | "manual"; background?: boolean };
      if (value.scope) setAssistantScope(value.scope);
      if (value.background !== undefined) setBackgroundChecks(value.background);
    } catch {}
  }, [roomId]);

  React.useEffect(() => {
    if (!roomId) return;
    localStorage.setItem(`kan-assistant:${roomId}`, JSON.stringify({ scope: assistantScope, background: backgroundChecks }));
  }, [assistantScope, backgroundChecks, roomId]);

  React.useEffect(() => {
    transport.setExecutorReady(agent.status.state === "ready", agent.status.agent ?? "Kan", assistantScope, backgroundChecks);
  }, [agent.status.agent, agent.status.state, assistantScope, backgroundChecks, transport]);

  /** Upsert by id: a replay and a live append are the same operation. */
  const upsert = React.useCallback((entry: ThreadEntry) => {
    if (!entryOrderRef.current.has(entry.id)) {
      entryOrderRef.current.set(entry.id, nextEntryOrderRef.current++);
    }
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
    }, (snapshot) => {
      setRoomSnapshot(snapshot);
      if (snapshot.ready && snapshot.room?.assistantPaused !== undefined) setAssistantPaused(snapshot.room.assistantPaused);
    });
  }, [transport, upsert]);

  const executeTrigger = React.useCallback(async (trigger: TriggerEntry) => {
    const key = `${trigger.triggerId}:${trigger.attempt}`;
    if (agent.busy || attempts.current.has(key) || activeLease.current || claiming.current) return;
    claiming.current = true;
    setActionError(null);
    let lease;
    try { lease = await transport.claimTrigger(trigger.triggerId); }
    finally { claiming.current = false; }
    if (!lease) return;
    attempts.current.add(key);
    const execution = startLeaseExecution({
      triggerId: trigger.triggerId,
      attempt: trigger.attempt,
      runId: lease.runId,
      leaseToken: lease.leaseToken,
      expiresAt: lease.expiresAt,
      mode: trigger.mode,
      getContext: async (signal) => {
        if (signal.aborted) throw new DOMException("assistant turn cancelled", "AbortError");
        if (!online) return (transport as LocalTransport).getLocalContext(lease.runId);
        const value = await getServerRunContext(roomId!, lease.runId, lease.leaseToken);
        return { revision: value.revision, value };
      },
      run: (mode, context, signal) => runAssistantTurn({ ready: agent.status.state === "ready", agentId: agent.status.agent ?? "Kan", run: (nextMode, nextContext, nextSignal) => agent.runStructured(nextMode, nextContext, nextSignal) }, mode, context, signal),
      heartbeat: () => online ? heartbeatServerRun(roomId!, lease.runId, lease.leaseToken) : (transport as LocalTransport).heartbeatLocal(lease.runId),
      complete: (input, signal) => {
        if (signal.aborted) return Promise.reject(new DOMException("assistant turn cancelled", "AbortError"));
        if (!online) return (transport as LocalTransport).completeLocal(lease.runId, input);
        return completeServerRun(roomId!, lease.runId, input, lease.leaseToken);
      },
      fail: async (status) => {
        if (status === "failed") setActionError("Kan could not finish this request. You can retry from the thread.");
        if (online) await patchServerRun(roomId!, lease.runId, lease.leaseToken, { id: crypto.randomUUID(), status });
        else await (transport as LocalTransport).failLocal(lease.runId, status);
      },
    });
    activeLease.current = execution;
    await execution.promise.finally(() => {
      if (activeLease.current === execution) activeLease.current = undefined;
      setLeaseRevision((revision) => revision + 1);
    });
  }, [agent, online, roomId, transport]);

  React.useEffect(() => {
    if (!roomId || !roomSnapshot.ready || !roomSnapshot.sessionId || agent.status.state !== "ready") return;
    for (const entry of entries) {
      if (entry.kind !== "trigger" || entry.status !== "offered" || entry.assigneeSessionId !== roomSnapshot.sessionId) continue;
      void executeTrigger(entry).catch(reportError);
    }
  }, [agent.status.state, entries, executeTrigger, leaseRevision, online, reportError, roomId, roomSnapshot.ready, roomSnapshot.sessionId]);

  React.useEffect(() => {
    const active = activeLease.current;
    if (!active) return;
    const trigger = roomSnapshot.triggers.find((candidate) => candidate.id === active.triggerId);
    if (!roomSnapshot.connected || agent.status.state !== "ready" || (online && assistantPaused && active.mode !== "act") || (trigger && ["cancelled", "failed", "expired"].includes(trigger.status))) active.controller.abort();
  }, [agent.status.state, assistantPaused, online, roomSnapshot]);
  React.useEffect(() => () => { activeLease.current?.controller.abort(); }, [transport]);

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

  React.useEffect(() => {
    void getInstallationProfile().then((p) => {
      if (p?.name) {
        setUserName(p.name);
        setUserId(p.installationId);
      }
    });
  }, []);

  function handleSend({ text, files, replyToEntryId }: { text: string; files: File[]; replyToEntryId?: string }) {
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
      source: "typed",
      replyToEntryId,
    }).catch(reportError);

  }

  function resolveSuggestion(suggestion: SuggestionEntry, accepted: boolean) {
    void transport.resolveSuggestion(suggestion.id, accepted).catch(reportError);
  }

  function claimTrigger(trigger: TriggerEntry) { if (!roomSnapshot.ready) return; void executeTrigger(trigger).catch(reportError); }
  function cancelTrigger(trigger: TriggerEntry) { if (activeLease.current?.triggerId === trigger.triggerId) activeLease.current.controller.abort(); void transport.cancelTrigger(trigger.triggerId).catch(reportError); }
  function retryTrigger(trigger: TriggerEntry) { void transport.retryTrigger(trigger.triggerId).catch(reportError); }
  function resolveOffer(offer: OfferEntry, accepted: boolean) { void transport.resolveOffer(offer.id, accepted).catch(reportError); }

  const participants = React.useMemo(() => {
    const humans = roomSnapshot.members.map((member) => ({ id: member.id, name: member.id === userId ? userName : member.name, kind: "human" as const }));
    const known = new Set(humans.map((member) => member.id));
    if (!known.has(userId)) { humans.unshift({ id: userId, name: userName, kind: "human" as const }); known.add(userId); }
    for (const participant of hackathonConversation.participants) {
      if (!known.has(participant.id)) { humans.push({ ...participant, kind: "human" as const }); known.add(participant.id); }
    }
    const agents = roomSnapshot.executors.filter((executor) => executor.agentId).map((executor) => ({ id: executor.agentId, name: executor.agentId, kind: "agent" as const, operatorId: executor.userId }));
    if (!agents.some((participant) => participant.id === AGENT)) agents.push({ id: AGENT, name: agent.status.agent ?? "Kan", kind: "agent", operatorId: userId });
    return [...humans, ...agents];
  }, [agent.status.agent, roomSnapshot.executors, roomSnapshot.members, userId, userName]);

  const view = React.useMemo(
    () => ({
      pendingIds,
      streamingIds,
      entryOrder: entryOrderRef.current,
    }),
    [pendingIds, streamingIds]
  );

  return (
    <ThreadPanel
      className={className}
      channel={roomId ? `room/${roomId.slice(0, 8)}` : "#feature-kickoff"}
      entries={entries}
      participants={participants}
      currentUserId={userId}
      anchors={selectedAnchors}
      canvasNodeCount={shapeCount}
      view={view}
      toolbar={
        <div className="flex flex-col gap-2 border-b border-border p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Kan · personal agent</span>
            <ToggleGroup value={[assistantScope]} onValueChange={(value) => { const next = value[0]; if (next === "own" || next === "room" || next === "manual") setAssistantScope(next); }} size="sm" variant="outline">
              <ToggleGroupItem value="own">My requests</ToggleGroupItem>
              <ToggleGroupItem value="room">Help room</ToggleGroupItem>
              <ToggleGroupItem value="manual">Manual</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <label className="flex items-center justify-between gap-2 text-muted-foreground">
            Allow background checks using my agent
            <Switch checked={backgroundChecks} onCheckedChange={setBackgroundChecks} />
          </label>
          {online ? <label className="flex items-center justify-between gap-2 text-muted-foreground">Pause contextual assistance<Switch checked={assistantPaused} onCheckedChange={(value) => { setAssistantPaused(value); void patchServerRoom(roomId!, { assistantPaused: value }).catch(() => undefined); }} /></label> : null}
          {actionError || roomSnapshot.error ? <p role="status">{actionError ?? roomSnapshot.error}</p> : null}
          <ConversationSimulator
            script={hackathonConversation}
            onLine={simulateLine}
            disabled={agent.status.state !== "ready" || !canvasTools || agent.busy}
            onStop={() => void agent.cancel()}
          />
        </div>
      }
      onClose={onClose}
      onCopyLink={() => navigator.clipboard?.writeText(window.location.href)}
      onJumpToNode={jumpToNode}
      resolveAnchorLabel={labelForNode}
      onAcceptSuggestion={(suggestion) => resolveSuggestion(suggestion, true)}
      onDismissSuggestion={(suggestion) => resolveSuggestion(suggestion, false)}
      onClaimTrigger={claimTrigger}
      onCancelTrigger={cancelTrigger}
      onRetryTrigger={retryTrigger}
      onAcceptOffer={(offer) => resolveOffer(offer, true)}
      onDismissOffer={(offer) => resolveOffer(offer, false)}
      composer={{
        onSend: handleSend,
        disabled: userId === DEFAULT_USER || !roomSnapshot.ready,
        modelSelection: models.length ? modelSelection : undefined,
        models,
        modelDisabled: agent.busy || agent.status.state !== "ready",
        onModelSelectionChange: (selection) => { void agent.setModel(selection.id); },
      }}
    />
  );
}
