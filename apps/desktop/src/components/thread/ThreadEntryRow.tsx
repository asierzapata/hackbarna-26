import * as React from "react";

import type { ThreadEntry } from "@/lib/thread";

import { AgentEntryCard } from "./AgentEntryCard";
import { SuggestionCard } from "./SuggestionCard";
import { SystemEntryRow } from "./SystemEntryRow";
import { UserMessageEntry } from "./UserMessageEntry";

/**
 * Renderer for one entry kind. Keyed by `entry.kind`, so adding a source means
 * adding a type to `ThreadEntry` plus one entry here — or passing `renderers`
 * to `ThreadPanel` to register a kind the library doesn't know about.
 */
export interface EntryRendererProps {
  entry: never;
  /** Sent from this client, not yet acknowledged by the room. */
  pending?: boolean;
  /** Agent turn whose tokens are still arriving. */
  streaming?: boolean;
  /** Steps rendered before the "N more steps" fold. */
  visibleSteps?: number;
}

export type EntryRenderer = React.ComponentType<EntryRendererProps>;

export type ThreadRenderers = Record<string, EntryRenderer>;

export const defaultRenderers = {
  message: UserMessageEntry,
  agent: AgentEntryCard,
  suggestion: SuggestionCard,
  system: SystemEntryRow,
  // `transcript` has no entry here: consecutive transcript lines are folded
  // into a TranscriptRun by buildThreadRows and never rendered standalone.
} as unknown as ThreadRenderers;

export function ThreadEntryRow({
  entry,
  pending,
  streaming,
  visibleSteps,
  renderers,
}: {
  entry: ThreadEntry;
  pending?: boolean;
  streaming?: boolean;
  visibleSteps?: number;
  renderers?: ThreadRenderers;
}) {
  const Renderer = renderers?.[entry.kind] ?? defaultRenderers[entry.kind];

  if (!Renderer) {
    if (import.meta.env.DEV) {
      console.warn(`No thread renderer registered for kind "${entry.kind}"`);
    }
    return null;
  }

  // Render state travels beside the entry, not inside it, so a renderer can
  // ignore it entirely and still receive a wire-shaped entry.
  return (
    <Renderer
      entry={entry as never}
      pending={pending}
      streaming={streaming}
      visibleSteps={visibleSteps}
    />
  );
}
