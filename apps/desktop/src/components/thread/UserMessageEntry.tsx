import { RiFile3Line } from "@remixicon/react";
import { cn } from "cn";

import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import type { MessageEntry, ThreadAttachment } from "@/lib/thread";
import { formatTime } from "@/lib/thread";

import { AnchorChip } from "./AnchorChip";
import { MentionText } from "./MentionText";
import { useAuthor, useThread } from "./thread-context";

function ThreadAttachmentItem({ attachment }: { attachment: ThreadAttachment }) {
  return (
    <Attachment state={attachment.state ?? "done"} size="sm">
      {attachment.kind === "image" && attachment.url ? (
        <AttachmentMedia variant="image">
          <img src={attachment.url} alt={attachment.name} />
        </AttachmentMedia>
      ) : (
        <AttachmentMedia variant="icon">
          <RiFile3Line />
        </AttachmentMedia>
      )}
      <AttachmentContent>
        <AttachmentTitle>{attachment.name}</AttachmentTitle>
        {attachment.meta ? (
          <AttachmentDescription>{attachment.meta}</AttachmentDescription>
        ) : null}
      </AttachmentContent>
    </Attachment>
  );
}

/**
 * A message typed by a participant. Rendered full width rather than as an
 * opposing chat bubble — the thread is a shared log, not a two-party DM, so
 * "mine vs theirs" would be misleading with several people in the room.
 */
export function UserMessageEntry({
  entry,
  pending = false,
}: {
  entry: MessageEntry;
  pending?: boolean;
}) {
  const author = useAuthor(entry.authorId);
  const { currentUserId, onJumpToNode } = useThread();
  const isSelf = entry.authorId === currentUserId;

  return (
    <Message align="start">
      <MessageContent>
        <Bubble
          variant="ghost"
          className={cn(
            "w-full border border-solid border-border bg-muted p-2.5",
            isSelf && "border-foreground/20",
            pending && "opacity-60"
          )}
        >
          <BubbleContent className="flex w-full flex-col gap-1.5">
            <MessageHeader className="gap-2 px-0">
              <span className="font-medium text-foreground">{author.name}</span>
              <span className="tabular-nums">{formatTime(entry.at, true)}</span>
              {pending ? (
                <span className="shimmer ms-auto">sending</span>
              ) : null}
            </MessageHeader>

            <MentionText text={entry.text} className="text-xs leading-relaxed" />

            {entry.attachments?.length ? (
              <AttachmentGroup>
                {entry.attachments.map((attachment) => (
                  <ThreadAttachmentItem key={attachment.id} attachment={attachment} />
                ))}
              </AttachmentGroup>
            ) : null}
          </BubbleContent>
        </Bubble>

        {entry.anchors?.length ? (
          <MessageFooter className="flex-wrap gap-1 px-0">
            {entry.anchors.map((anchor) => (
              <AnchorChip key={anchor.nodeId} anchor={anchor} onJump={onJumpToNode} />
            ))}
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  );
}
