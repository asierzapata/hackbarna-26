import * as React from "react";

import type { ConversationLine, ConversationScript } from "@/lib/conversation-script";

export const DEFAULT_CONVERSATION_DELAY_MS = 1000;

/**
 * Plays a `ConversationScript` back one line at a time, on a timer, so the
 * thread receives entries the way a live call would rather than all at once.
 *
 * The delay lives in a ref, not just state: reading it fresh on every tick
 * means dragging the slider mid-playback changes the pace of the *next* line
 * immediately, without restarting the run.
 */
export function useConversationPlayer(
  script: ConversationScript,
  onLine: (line: ConversationLine, index: number) => void | Promise<void>
) {
  const [playing, setPlaying] = React.useState(false);
  const [delayMs, setDelayMs] = React.useState(DEFAULT_CONVERSATION_DELAY_MS);
  const [cursor, setCursor] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  const delayRef = React.useRef(delayMs);
  delayRef.current = delayMs;
  const onLineRef = React.useRef(onLine);
  onLineRef.current = onLine;

  const total = script.lines.length;

  React.useEffect(() => {
    if (!playing) return;
    if (cursor >= total) {
      setPlaying(false);
      return;
    }

    // The first line lands immediately; every line after waits the current
    // slider delay, so pressing play doesn't feel like it stalled.
    let cancelled = false;
    const timer = setTimeout(
      async () => {
        try {
          await onLineRef.current(script.lines[cursor], cursor);
          if (!cancelled) setCursor((c) => c + 1);
        } catch (cause) {
          if (!cancelled) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setPlaying(false);
          }
        }
      },
      cursor === 0 ? 0 : delayRef.current
    );
    return () => { cancelled = true; clearTimeout(timer); };
  }, [playing, cursor, total, script.lines]);

  const start = React.useCallback(() => {
    setError(null);
    setCursor(0);
    setPlaying(true);
  }, []);

  const stop = React.useCallback(() => setPlaying(false), []);

  return { playing, delayMs, setDelayMs, cursor, total, start, stop, error };
}
