import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import type { AgentEntry } from "@/lib/thread";
import { AgentDiagnostics } from "@/components/AgentDiagnostics";

import { AgentActivity } from "./AgentActivity";
import { AgentMarkdown } from "./AgentMarkdown";
import { useAuthor, useThread } from "./thread-context";

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
  const { onJumpToEntry, onJumpToNode, onReply, resolveAnchorLabel } = useThread();
  const hasSummary = entry.text.trim().length > 0;

  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="agent">
          <BubbleContent className="flex w-full flex-col gap-3">
            <MessageHeader className="gap-2 px-0 text-agent">
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-agent" />
              <span className="font-medium">{agent.name}</span>
            </MessageHeader>
            <AgentActivity
              steps={entry.steps}
              thought={entry.thought}
              thinking={entry.thinking}
              running={streaming}
              durationMs={entry.durationMs}
            />
            {hasSummary ? (
              <AgentMarkdown>{entry.text}</AgentMarkdown>
            ) : streaming ? null : (
              <span className="text-xs leading-relaxed text-muted-foreground">
                No response received
              </span>
            )}
            {entry.sources?.length ? (
              <div className="flex flex-wrap gap-1">
                {entry.sources.map((source, index) => {
                  const label = source.kind === "shape" ? resolveAnchorLabel?.(source.id) : undefined;
                  return (
                    <Button
                      key={`${source.kind}:${source.id}`}
                      variant="link"
                      size="xs"
                      className="max-w-full"
                      onClick={() => source.kind === "entry"
                        ? onJumpToEntry?.(source.id)
                        : onJumpToNode?.({ nodeId: source.id, label: source.id })}
                    >
                      <span className="truncate">
                        {source.kind === "entry" ? `Source ${index + 1}`
                          : label && label !== source.id ? label : `Canvas item ${index + 1}`}
                      </span>
                    </Button>
                  );
                })}
              </div>
            ) : null}

            <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
              {entry.traceId ? <AgentDiagnostics turnId={entry.traceId} /> : null}
              {/* Replying to a turn that has not finished answering is noise. */}
              {streaming ? null : <Button variant="ghost" size="xs" onClick={() => onReply?.(entry)}>Reply</Button>}
            </div>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
