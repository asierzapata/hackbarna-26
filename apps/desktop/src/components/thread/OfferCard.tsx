import { RiCheckLine, RiCloseLine } from "@remixicon/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import type { OfferEntry } from "@/lib/thread";

import { useThread } from "./thread-context";

export function OfferCard({ entry }: { entry: OfferEntry }) {
  const { onAcceptOffer, onDismissOffer, onReply } = useThread();
  const open = entry.status === "open";
  return (
    <Message align="start">
      <MessageContent>
        <Bubble variant="ghost" className="w-full rounded-lg border border-solid border-agent/20 bg-agent-subtle/60 p-3">
          <BubbleContent className="flex flex-col gap-2">
            <div className="flex items-center gap-2"><Badge variant="secondary">Offer</Badge><strong className="truncate">{entry.title}</strong></div>
            <p className="text-muted-foreground">{entry.text}</p>
            <p className="text-xs text-muted-foreground">{entry.request}</p>
            <Button variant="link" size="xs" onClick={() => onReply?.(entry)}>Reply</Button>
            {open ? <div className="flex gap-2"><Button size="sm" onClick={() => onAcceptOffer?.(entry)}><RiCheckLine data-icon="inline-start" />Do this</Button><Button variant="outline" size="sm" onClick={() => onDismissOffer?.(entry)}><RiCloseLine data-icon="inline-start" />Dismiss</Button></div> : <Badge variant="outline">{entry.status}</Badge>}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
