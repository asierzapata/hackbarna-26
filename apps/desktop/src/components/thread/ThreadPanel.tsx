import * as React from "react";
import { RiCloseLine, RiSearchLine } from "@remixicon/react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import type {
  CanvasAnchor,
  Participant,
  ThreadEntry,
  ThreadViewState,
} from "@/lib/thread";
import { buildThreadRows, toParticipantMap } from "@/lib/thread";

import { ThreadComposer, type ThreadComposerProps } from "./ThreadComposer";
import { ThreadEntryRow, type ThreadRenderers } from "./ThreadEntryRow";
import { TranscriptRun } from "./TranscriptRun";
import { ThreadProvider, type ThreadActions } from "./thread-context";
import { useQaSource } from "@/lib/qa-source";

export interface ThreadPanelProps extends ThreadActions {
  /** Canvas channel name shown next to the Thread badge. */
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
  /** Rendered in the header row, right of the channel name: the assistant control. */
  headerAction?: React.ReactNode;
  /**
   * One transient line between the header and the stream: what the assistant is
   * doing, or what just failed. Rendered only when it has content, so the panel
   * costs nothing when there is nothing to say.
   */
  status?: React.ReactNode;
  /** Ambient state for the footer status bar, e.g. the call transcript state. */
  footerStatus?: React.ReactNode;
  /** Extra controls under the header, e.g. dev tools. */
  /** Client-only render state: what is unacknowledged, streaming, interim. */
  view?: ThreadViewState;
  onClose?: () => void;
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

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : many;

export function ThreadPanel({
  channel,
  entries,
  participants,
  currentUserId,
  anchors = [],
  canvasNodeCount,
  renderers,
  headerAction,
  status,
  footerStatus,
  view,
  onClose,
  composer,
  className,
  ...actions
}: ThreadPanelProps) {
  const [search, setSearch] = React.useState("");
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [expandedTranscriptIds, setExpandedTranscriptIds] = React.useState<ReadonlySet<string>>(new Set());
  const [replyTo, setReplyTo] = React.useState<
    { id: string; label: string } | undefined
  >();
  useQaSource("threadView", () => ({ search, channel, participants, currentUserId }));

  const participantMap = React.useMemo(
    () => toParticipantMap(participants),
    [participants],
  );
  const rows = React.useMemo(
    () => buildThreadRows(entries, search, view),
    [entries, search, view],
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
          "@container/thread flex h-full w-[440px] min-w-0 shrink-0 flex-col border-s border-border bg-card font-sans text-sm",
          className,
        )}
      >
        <header className="flex flex-col gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight" title={channel}>
              Conversation
            </h2>
            {headerAction}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Search the thread"
              aria-expanded={searchOpen}
              data-testid="thread-search-toggle"
              onClick={() => {
                const next = !searchOpen;
                setSearchOpen(next);
                if (next) requestAnimationFrame(() => searchRef.current?.focus());
                else setSearch("");
              }}
            >
              <RiSearchLine />
            </Button>
            {onClose ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close thread"
                title="Close conversation (Esc)"
                onClick={onClose}
              >
                <RiCloseLine />
              </Button>
            ) : null}
          </div>

          {searchOpen ? (
            <Input
              ref={searchRef}
              type="search"
              aria-label="Search the thread"
              data-testid="thread-search"
              placeholder="Find in thread"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                // Swallow it: Escape closes the whole panel one level up, and
                // the first Escape from a search box should only clear it.
                event.stopPropagation();
                setSearch("");
                setSearchOpen(false);
              }}
            />
          ) : null}
        </header>

        {status ? (
          <div
            data-testid="thread-status"
            className="flex min-h-9 items-center gap-2 border-b border-border px-3 py-1.5 text-muted-foreground"
          >
            {status}
          </div>
        ) : null}

        <MessageScrollerProvider autoScroll>
          <MessageScroller className="flex-1 border-b border-border">
            <MessageScrollerViewport>
              {rows.length ? (
                <MessageScrollerContent className="gap-4 p-4">
                  {rows.map((row) => (
                    <MessageScrollerItem
                      key={row.id}
                      messageId={row.id}
                    >
                      {row.type === "transcript-run" ? (
                        <TranscriptRun
                          entries={row.entries}
                          interimIds={row.interimIds}
                          open={row.entries.some((entry) => expandedTranscriptIds.has(entry.id))}
                          onOpenChange={(open) => setExpandedTranscriptIds((previous) => {
                            const next = new Set(previous);
                            for (const entry of row.entries) { if (open) next.add(entry.id); else next.delete(entry.id); }
                            return next;
                          })}
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
                    <EmptyTitle>
                      {search.trim() ? "No matches" : "A place to think together"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {search.trim()
                        ? `Nothing in this thread matches "${search.trim()}".`
                        : "Share an idea, ask a question, or select something on the canvas to discuss it."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        <div className="flex flex-col gap-3 bg-background/60 p-4">
          <ThreadComposer
            anchors={anchors}
            {...composer}
            replyTo={replyTo}
            onClearReply={() => setReplyTo(undefined)}
          />
          <div className="flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
            <span>
              {search.trim()
                ? `${rows.length} of ${entries.length} ${plural(entries.length, "entry", "entries")}`
                : `${entries.length} ${plural(entries.length, "entry", "entries")}`}
            </span>
            {footerStatus ? (
              <span className="min-w-0 truncate">{footerStatus}</span>
            ) : null}
            {canvasNodeCount !== undefined ? (
              <span className="shrink-0">
                {canvasNodeCount} {plural(canvasNodeCount, "node", "nodes")}
              </span>
            ) : null}
          </div>
        </div>
      </aside>
    </ThreadProvider>
  );
}
