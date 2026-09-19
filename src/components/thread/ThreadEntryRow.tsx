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
export type EntryRenderer = React.ComponentType<{ entry: never }>;

export type ThreadRenderers = Record<
  string,
  React.ComponentType<{ entry: never }>
>;

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
  renderers,
}: {
  entry: ThreadEntry;
  renderers?: ThreadRenderers;
}) {
  const Renderer = renderers?.[entry.kind] ?? defaultRenderers[entry.kind];

  if (!Renderer) {
    if (import.meta.env.DEV) {
      console.warn(`No thread renderer registered for kind "${entry.kind}"`);
    }
    return null;
  }

  return <Renderer entry={entry as never} />;
}
