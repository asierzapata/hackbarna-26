import * as React from "react";

import { ThreadPanel } from "./thread";
import { useDevin, type DevinToolCall } from "./devin-context";
import type {
  AgentEntry,
  AgentStep,
  MessageEntry,
  SuggestionEntry,
  ThreadEntry,
} from "@/lib/thread";
import {
  demoAnchors,
  demoEntries,
  demoParticipants,
} from "@/lib/thread-fixtures";

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

/**
 * Local stand-in for the realtime room. Swap `entries` for the synced log and
 * `onSend` for the room's publish call — `ThreadPanel` itself is transport
 * agnostic and only needs entries in, callbacks out.
 */
export function ChatPanel({ onClose }: { onClose?: () => void }) {
  const [entries, setEntries] = React.useState<ThreadEntry[]>(demoEntries);
  const [micActive, setMicActive] = React.useState(false);
  const devin = useDevin();

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
   */
  async function askDevin(text: string) {
    const id = `devin-${Date.now()}`;
    const startedAt = Date.now();

    setEntries((prev) => [
      ...prev,
      {
        id,
        kind: "agent",
        at: new Date().toISOString(),
        authorId: AGENT,
        model: devin.status.agent ?? "Devin",
        text: "",
        streaming: true,
      },
    ]);

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
      patchAgent(id, (entry) => ({
        ...entry,
        streaming: false,
        durationMs: Date.now() - startedAt,
      }));
    }
  }

  function handleSend({ text, files }: { text: string; files: File[] }) {
    const message: MessageEntry = {
      id: `local-${Date.now()}`,
      kind: "message",
      at: new Date().toISOString(),
      authorId: CURRENT_USER,
      text,
      anchors: demoAnchors,
      attachments: files.map((file, i) => ({
        id: `local-file-${Date.now()}-${i}`,
        name: file.name,
        kind: file.type.startsWith("image/") ? "image" : "file",
        url: URL.createObjectURL(file),
        meta: `${Math.round(file.size / 1024)} KB`,
        state: "done",
      })),
    };
    setEntries((prev) => [...prev, message]);

    // Connected Devin answers every message; until then the thread is local.
    if (devin.status.state === "ready") void askDevin(text);
  }

  function resolveSuggestion(suggestion: SuggestionEntry, accepted: boolean) {
    setEntries((prev) => [
      ...prev.filter((entry) => entry.id !== suggestion.id),
      {
        id: `resolved-${suggestion.id}`,
        kind: "system",
        at: new Date().toISOString(),
        authorId: CURRENT_USER,
        text: accepted
          ? `${CURRENT_USER} added '${suggestion.proposal.label}' to the canvas`
          : `${CURRENT_USER} dismissed a suggestion`,
      },
    ]);
  }

  return (
    <ThreadPanel
      channel="#feature-kickoff"
      entries={entries}
      participants={demoParticipants}
      currentUserId={CURRENT_USER}
      anchors={demoAnchors}
      canvasNodeCount={42}
      onClose={onClose}
      onCopyLink={() => navigator.clipboard?.writeText(window.location.href)}
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
