import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import type { SystemEntry } from "@/lib/thread";
import { formatTime } from "@/lib/thread";

/** Room narration — canvas moves, joins, renames. */
export function SystemEntryRow({ entry }: { entry: SystemEntry }) {
  return (
    <Marker>
      <MarkerIcon aria-hidden>·</MarkerIcon>
      <MarkerContent className="min-w-0 flex-1 wrap-break-word">
        {entry.text}
      </MarkerContent>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatTime(entry.at)}
      </span>
    </Marker>
  );
}
