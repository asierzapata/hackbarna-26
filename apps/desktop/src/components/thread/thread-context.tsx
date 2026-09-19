import * as React from "react";

import type { CanvasAnchor, OfferEntry, ParticipantMap, SuggestionEntry, ThreadEntry, TriggerEntry } from "@/lib/thread";
import { participantOf } from "@/lib/thread";

export interface ThreadActions {
  /** Focus a canvas node — used by agent step rows and anchor chips. */
  onJumpToNode?: (anchor: CanvasAnchor) => void;
  /** Scroll the thread to an entry (a suggestion's source line, say). */
  onJumpToEntry?: (entryId: string) => void;
  /**
   * Resolves a shape id to a human label. Anchors travel the wire as bare
   * shape ids, so the name has to come from the canvas at render time rather
   * than being frozen into the entry when it was written.
   */
  resolveAnchorLabel?: (nodeId: string) => string | undefined;
  onAcceptSuggestion?: (suggestion: SuggestionEntry) => void;
  onDismissSuggestion?: (suggestion: SuggestionEntry) => void;
  onClaimTrigger?: (trigger: TriggerEntry) => void;
  onCancelTrigger?: (trigger: TriggerEntry) => void;
  onRetryTrigger?: (trigger: TriggerEntry) => void;
  onAcceptOffer?: (offer: OfferEntry) => void;
  onDismissOffer?: (offer: OfferEntry) => void;
  onReply?: (entry: ThreadEntry) => void;
}

export interface ThreadContextValue extends ThreadActions {
  participants: ParticipantMap;
  /** Whose seat this client is in, so their own messages can read differently. */
  currentUserId: string;
}

const ThreadContext = React.createContext<ThreadContextValue | null>(null);

export function ThreadProvider({
  value,
  children,
}: {
  value: ThreadContextValue;
  children: React.ReactNode;
}) {
  return <ThreadContext.Provider value={value}>{children}</ThreadContext.Provider>;
}

export function useThread() {
  const ctx = React.useContext(ThreadContext);
  if (!ctx) {
    throw new Error("useThread must be used inside a ThreadProvider");
  }
  return ctx;
}

/** Resolves an author id against the room roster, never throwing on unknowns. */
export function useAuthor(authorId: string) {
  const { participants } = useThread();
  return participantOf(participants, authorId);
}
