import { RiLightbulbLine } from "@remixicon/react";

import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Message, MessageContent } from "@/components/ui/message";
import type { SuggestionEntry } from "@/lib/thread";

import { useThread } from "./thread-context";

/**
 * An agent proposing a canvas change. Stays in the thread until someone
 * accepts or dismisses it, so the decision itself is part of the log.
 */
export function SuggestionCard({ entry }: { entry: SuggestionEntry }) {
  const { onAcceptSuggestion, onDismissSuggestion, onJumpToEntry } = useThread();

  return (
    <Message align="start">
      <MessageContent>
        <Bubble
          variant="ghost"
          className="w-full border border-solid border-border border-s-2 border-s-suggestion bg-suggestion-subtle p-3"
        >
          <BubbleContent className="flex w-full flex-col gap-2.5">
            <div className="flex items-center gap-2 text-xs">
              <RiLightbulbLine className="size-3.5 shrink-0 text-suggestion-foreground" />
              <span className="font-medium text-suggestion-foreground">
                suggestion
              </span>
              {entry.sourceEntryId && onJumpToEntry ? (
                <Button
                  variant="link"
                  size="xs"
                  className="min-w-0 truncate text-muted-foreground"
                  onClick={() => onJumpToEntry(entry.sourceEntryId!)}
                >
                  {entry.sourceLabel}
                </Button>
              ) : (
                <span className="min-w-0 truncate text-muted-foreground">
                  {entry.sourceLabel}
                </span>
              )}
              {entry.shortcut ? (
                <span className="ms-auto flex shrink-0 items-center gap-1 text-muted-foreground">
                  <Kbd>{entry.shortcut}</Kbd> accept
                </span>
              ) : null}
            </div>

            <blockquote className="border-s-2 border-border bg-background px-2.5 py-2 text-xs leading-relaxed italic wrap-break-word text-muted-foreground">
              {entry.quote}
            </blockquote>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Proposed:</span>
              <Badge variant="secondary" className="gap-1">
                <span className="font-medium">{entry.proposal.type}</span>·
                <span>{entry.proposal.label}</span>
              </Badge>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => onAcceptSuggestion?.(entry)}>
                Add to canvas
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onDismissSuggestion?.(entry)}
              >
                Dismiss
              </Button>
            </div>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
