import * as React from "react";
import { RiCloseLine, RiLink } from "@remixicon/react";
import { cn } from "cn";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  CanvasAnchor,
  Participant,
  ThreadEntry,
  ThreadFilter,
  ThreadViewState,
} from "@/lib/thread";
import { buildThreadRows, toParticipantMap } from "@/lib/thread";

import { ThreadComposer, type ThreadComposerProps } from "./ThreadComposer";
import { ThreadEntryRow, type ThreadRenderers } from "./ThreadEntryRow";
import { TranscriptRun } from "./TranscriptRun";
import { ThreadProvider, type ThreadActions } from "./thread-context";
import { useQaSource } from "@/lib/qa-source";

const filters: { value: ThreadFilter; label: string }[] = [
  { value: "everything", label: "Everything" },
  { value: "messages", label: "Messages" },
  { value: "agent", label: "Agent activity" },
];

export interface ThreadPanelProps extends ThreadActions {
  /** Room channel name shown next to the Thread badge. */
  channel: string;
  /** Merged, timestamp-ordered stream from all sources. */
  entries: ThreadEntry[];
  participants: Participant[];
  currentUserId: string;
  /** Canvas nodes selected right now — passed through to the composer. */
  anchors?: CanvasAnchor[];
  /** Total canvas node count, for the footer. */
  canvasNodeCount?: number;
  /** Register renderers for entry kinds beyond the built-in ones. */
  renderers?: ThreadRenderers;
  /** Extra controls rendered between the header and the entry list, e.g. dev tools. */
  toolbar?: React.ReactNode;
  /** Client-only render state: what is unacknowledged, streaming, interim. */
  view?: ThreadViewState;
  onClose?: () => void;
  onCopyLink?: () => void;
  composer?: Pick<
    ThreadComposerProps,
    "onSend"
    | "disabled"
    | "agentReady"
    | "modelSelection"
    | "models"
    | "modelDisabled"
    | "onModelSelectionChange"
    | "replyTo"
    | "onClearReply"
  >;
  className?: string;
}

export function ThreadPanel({
  channel,
  entries,
  participants,
  currentUserId,
  anchors = [],
  canvasNodeCount,
  renderers,
  toolbar,
  view,
  onClose,
  onCopyLink,
  composer,
  className,
  ...actions
}: ThreadPanelProps) {
  const [filter, setFilter] = React.useState<ThreadFilter>("everything");
  const [replyTo, setReplyTo] = React.useState<
    { id: string; label: string } | undefined
  >();
  useQaSource("threadView", () => ({ filter, channel, participants, currentUserId }));

  const participantMap = React.useMemo(
    () => toParticipantMap(participants),
    [participants],
  );
  const rows = React.useMemo(
    () => buildThreadRows(entries, filter, view),
    [entries, filter, view],
  );

  const contextValue = React.useMemo(
    () => ({
      participants: participantMap,
      currentUserId,
      ...actions,
      onReply: (entry: ThreadEntry) =>
        setReplyTo({ id: entry.id, label: entry.kind }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [participantMap, currentUserId, ...Object.values(actions)],
  );

  return (
    <ThreadProvider value={contextValue}>
      <aside
        aria-label="Thread"
        className={cn(
          "flex h-full w-[440px] shrink-0 flex-col border-s border-border bg-background font-mono text-xs",
          className,
        )}
      >
        <header className="flex flex-col gap-2.5 border-b border-border p-3">
          <div className="flex items-center gap-2">
            <Badge className="gap-1.5">
              <span aria-hidden className="size-2 bg-primary-foreground" />
              Thread
            </Badge>
            <span className="min-w-0 truncate text-muted-foreground">
              {channel}
            </span>
            <span className="ms-auto flex shrink-0 items-center gap-1">
              {onCopyLink ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy thread link"
                  onClick={onCopyLink}
                >
                  <RiLink />
                </Button>
              ) : null}
              {onClose ? (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Close thread"
                  onClick={onClose}
                >
                  <Kbd>Esc</Kbd>
                  <RiCloseLine data-icon="inline-end" />
                </Button>
              ) : null}
            </span>
          </div>

          <Tabs
            value={filter}
            onValueChange={(value) => setFilter(value as ThreadFilter)}
          >
            {/* Default TabsList variant on purpose: its active styles live in
                the same Tailwind utility groups as the overrides below, so
                tailwind-merge resolves them. The `line` variant scopes its
                active styles through the list, which out-specifies them. */}
            <TabsList className="h-auto gap-1 bg-transparent p-0">
              {filters.map(({ value, label }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="h-7 flex-none border-border px-2 data-active:border-transparent data-active:bg-primary data-active:text-primary-foreground data-active:hover:bg-primary data-active:hover:text-primary-foreground dark:data-active:border-transparent dark:data-active:bg-primary dark:data-active:text-primary-foreground"
                >
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </header>

        {toolbar}

        <MessageScrollerProvider autoScroll>
          <MessageScroller className="flex-1 border-b border-border">
            <MessageScrollerViewport>
              {rows.length ? (
                <MessageScrollerContent className="gap-3 p-3">
                  {rows.map((row) => (
                    <MessageScrollerItem
                      key={row.id}
                      messageId={row.id}
                    >
                      {row.type === "transcript-run" ? (
                        <TranscriptRun
                          entries={row.entries}
                          interimIds={row.interimIds}
                        />
                      ) : (
                        <div id={`thread-entry-${row.entry.id}`}>
                          <ThreadEntryRow
                            entry={row.entry}
                            pending={row.pending}
                            streaming={row.streaming}
                            visibleSteps={row.visibleSteps}
                            renderers={renderers}
                          />
                        </div>
                      )}
                    </MessageScrollerItem>
                  ))}
                </MessageScrollerContent>
              ) : (
                <Empty className="h-full">
                  <EmptyHeader>
                    <EmptyTitle>Nothing here yet</EmptyTitle>
                    <EmptyDescription>
                      {filter === "everything"
                        ? "Start talking or type a message — the thread records both."
                        : "No entries match this filter."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        <div className="flex flex-col gap-2 p-3">
          <ThreadComposer
            anchors={anchors}
            {...composer}
            replyTo={replyTo}
            onClearReply={() => setReplyTo(undefined)}
          />
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Thread is append-only · {entries.length} entries</span>
            {canvasNodeCount !== undefined ? (
              <span>Canvas: {canvasNodeCount} nodes</span>
            ) : null}
          </div>
        </div>
      </aside>
    </ThreadProvider>
  );
}
