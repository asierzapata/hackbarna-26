import { RiCloseLine, RiPlayLine, RiRefreshLine } from "@remixicon/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import type { TriggerEntry } from "@/lib/thread";

import { useThread } from "./thread-context";

const labels: Record<TriggerEntry["status"], string> = {
  pending: "Queued",
  offered: "Waiting for an agent",
  needs_claim: "Needs an agent",
  running: "Working",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
};

export function TriggerEntryCard({ entry }: { entry: TriggerEntry }) {
  const { onClaimTrigger, onCancelTrigger, onRetryTrigger } = useThread();
  const active = entry.status === "pending" || entry.status === "offered" || entry.status === "needs_claim" || entry.status === "running";
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost" className="w-full rounded-lg bg-muted/60 p-3">
          <BubbleContent className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{labels[entry.status]}</Badge>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.reason}</span>
            </div>
            {active ? (
              <div className="flex flex-wrap gap-2">
                {entry.status !== "running" ? <Button size="sm" onClick={() => onClaimTrigger?.(entry)}><RiPlayLine data-icon="inline-start" />Run with my agent</Button> : null}
                <Button variant="outline" size="sm" onClick={() => onCancelTrigger?.(entry)}><RiCloseLine data-icon="inline-start" />Cancel</Button>
              </div>
            ) : entry.status === "failed" || entry.status === "cancelled" || entry.status === "expired" ? (
              <Button variant="outline" size="sm" onClick={() => onRetryTrigger?.(entry)}><RiRefreshLine data-icon="inline-start" />Retry</Button>
            ) : null}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
