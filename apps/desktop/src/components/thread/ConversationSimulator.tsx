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
  disabled = false,
  onStop,
}: {
  script: ConversationScript;
  onLine: (line: ConversationLine, index: number) => void | Promise<void>;
  disabled?: boolean;
  onStop?: () => void;
}) {
  const { playing, delayMs, setDelayMs, cursor, total, start, stop, error } =
    useConversationPlayer(script, onLine);

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2 text-muted-foreground" data-testid="conversation-simulator" data-playing={playing} data-cursor={cursor} data-total={total}>
      <Button
        variant="outline"
        size="sm"
        disabled={!playing && disabled}
        title={disabled && !playing ? "Connect a local agent on an offline canvas first" : undefined}
        onClick={playing ? () => { stop(); onStop?.(); } : start}
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

      {error ? <p role="alert" className="w-full text-destructive">{error}</p> : null}
      {playing || cursor > 0 ? (
        <span className="shrink-0 tabular-nums">
          {Math.min(cursor, total)}/{total}
        </span>
      ) : null}
    </div>
  );
}
