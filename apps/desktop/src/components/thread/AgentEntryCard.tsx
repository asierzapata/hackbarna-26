import { cn } from "cn";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import type { AgentEntry } from "@/lib/thread";

import { useAuthor } from "./thread-context";

/**
 * One agent turn, rendered as a compact conversation message so the agent
 * participates in the thread like anyone else.
 */
export function AgentEntryCard({
  entry,
  streaming = false,
}: {
  entry: AgentEntry;
  streaming?: boolean;
  visibleSteps?: number;
}) {
  const agent = useAuthor(entry.authorId);
  const summary = entry.text.replace(/\s+/g, " ").trim();
  const hasSummary = summary.length > 0;

  return (
    <Message align="start">
      <MessageContent>
        <Bubble
          variant="ghost"
          className="w-full border-2 border-solid border-agent bg-background p-3"
        >
          <BubbleContent className="flex w-full flex-col gap-1.5">
            <MessageHeader className="gap-2 px-0 text-agent">
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-agent" />
              <span className="font-medium">{agent.name}</span>
            </MessageHeader>
            {hasSummary ? (
              <p
                className={cn(
                  "text-xs leading-relaxed wrap-break-word",
                  streaming && "shimmer"
                )}
              >
                {summary}
              </p>
            ) : (
              <span
                role="status"
                aria-live="polite"
                className={cn(
                  "text-xs leading-relaxed text-muted-foreground",
                  streaming && "shimmer"
                )}
              >
                {streaming ? "Working" : "No response received"}
              </span>
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
