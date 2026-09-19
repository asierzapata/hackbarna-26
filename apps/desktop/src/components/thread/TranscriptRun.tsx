import { RiArrowRightSLine } from "@remixicon/react";
import { cn } from "cn";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Marker, MarkerContent } from "@/components/ui/marker";
import type { TranscriptEntry } from "@/lib/thread";
import { formatTime } from "@/lib/thread";

import { useAuthor, useThread } from "./thread-context";

/** One speech-to-text line, attributed to whoever was speaking. */
function TranscriptLine({
  entry,
  interim = false,
}: {
  entry: TranscriptEntry;
  interim?: boolean;
}) {
  const speaker = useAuthor(entry.authorId);
  const flagged = Boolean(entry.trigger);

  return (
    <div
      data-flagged={flagged || undefined}
      data-interim={interim || undefined}
      className={cn(
        "flex items-start gap-2 px-2 py-1 text-xs leading-relaxed",
        flagged && "border-s-2 border-agent bg-agent-subtle"
      )}
    >
      <span
        className={cn(
          "shrink-0 tabular-nums text-muted-foreground",
          flagged && "text-agent"
        )}
      >
        {formatTime(entry.at)}
      </span>
      <span className={cn("shrink-0 font-medium", flagged && "text-agent")}>
        {speaker.name}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 wrap-break-word",
          interim && "shimmer text-muted-foreground"
        )}
      >
        {entry.text}
      </span>
      {entry.trigger ? (
        <Badge className="shrink-0 bg-agent text-agent-foreground">
          {entry.trigger.label} · {entry.trigger.confidence.toFixed(2)}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * A consecutive stretch of call transcription, folded behind one divider so a
 * long stretch of audio doesn't drown out messages and agent output.
 *
 * Long runs start collapsed; short ones stay open.
 */
export function TranscriptRun({
  entries,
  interimIds,
  collapseAfter = 0,
  open,
  onOpenChange,
}: {
  entries: TranscriptEntry[];
  /** Lines the STT engine may still revise, so they render unsettled. */
  interimIds?: ReadonlySet<string>;
  collapseAfter?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { onJumpToEntry } = useThread();
  const flaggedCount = entries.filter((entry) => entry.trigger).length;

  return (
    <Collapsible
      defaultOpen={entries.length <= collapseAfter}
      open={open}
      onOpenChange={onOpenChange}
      className="flex flex-col gap-1"
    >
      <Marker
        variant="separator"
        render={
          <CollapsibleTrigger className="cursor-pointer hover:text-foreground" />
        }
      >
        <MarkerContent className="flex items-center gap-1.5">
          Call transcript · {entries.length} {entries.length === 1 ? "line" : "lines"}
          {entries.some((entry) => interimIds?.has(entry.id)) && <Badge variant="secondary">Live</Badge>}
          {flaggedCount > 0 ? (
            <Badge variant="outline" className="border-agent text-agent">
              {flaggedCount} flagged
            </Badge>
          ) : null}
          <RiArrowRightSLine className="transition-transform group-data-[panel-open]/marker:rotate-90" />
        </MarkerContent>
      </Marker>
      <CollapsibleContent className="flex flex-col">
        {entries.map((entry) => (
          <div
            key={entry.id}
            id={`thread-entry-${entry.id}`}
            onDoubleClick={() => onJumpToEntry?.(entry.id)}
          >
            <TranscriptLine entry={entry} interim={interimIds?.has(entry.id)} />
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
