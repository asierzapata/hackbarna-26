import { RiPlayFill, RiStopFill } from "@remixicon/react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import type { ConversationLine, ConversationScript } from "@/lib/conversation-script";
import { useConversationPlayer } from "@/hooks/use-conversation-player";

/**
 * Dev tool: replays a scripted two-person conversation into the thread, one
 * line at a time, so a node-producing agent has realistic transcript to react
 * to without anyone getting on a call.
 *
 * Lives outside `ThreadPanel`'s own state on purpose — it only needs a place
 * to hand entries to, so it stays reusable if the simulator ever moves.
 */
export function ConversationSimulator({
  script,
  onLine,
}: {
  script: ConversationScript;
  onLine: (line: ConversationLine) => void;
}) {
  const { playing, delayMs, setDelayMs, cursor, total, start, stop } =
    useConversationPlayer(script, onLine);

  return (
    <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-muted-foreground">
      <Button
        variant="outline"
        size="sm"
        onClick={playing ? stop : start}
        aria-label={playing ? "Stop simulated conversation" : "Simulate conversation"}
      >
        {playing ? (
          <RiStopFill data-icon="inline-start" />
        ) : (
          <RiPlayFill data-icon="inline-start" />
        )}
        {playing ? "Stop" : "Simulate conversation"}
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0">Delay</span>
        <Slider
          aria-label="Delay between messages"
          className="min-w-0"
          value={[delayMs]}
          onValueChange={(value) => setDelayMs(Array.isArray(value) ? value[0] : value)}
          min={200}
          max={3000}
          step={100}
        />
        <span className="w-9 shrink-0 tabular-nums">{(delayMs / 1000).toFixed(1)}s</span>
      </div>

      {playing || cursor > 0 ? (
        <span className="shrink-0 tabular-nums">
          {Math.min(cursor, total)}/{total}
        </span>
      ) : null}
    </div>
  );
}
