import * as React from "react";

import { ThreadPanel } from "./thread";
import type { MessageEntry, SuggestionEntry, ThreadEntry } from "@/lib/thread";
import {
  demoAnchors,
  demoEntries,
  demoParticipants,
} from "@/lib/thread-fixtures";

const CURRENT_USER = "asier";

/**
 * Local stand-in for the realtime room. Swap `entries` for the synced log and
 * `onSend` for the room's publish call — `ThreadPanel` itself is transport
 * agnostic and only needs entries in, callbacks out.
 */
export function ChatPanel({ onClose }: { onClose?: () => void }) {
  const [entries, setEntries] = React.useState<ThreadEntry[]>(demoEntries);
  const [micActive, setMicActive] = React.useState(false);

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
      }}
    />
  );
}
