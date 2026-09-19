import { cn } from "cn";

import { splitMentions } from "@/lib/thread";

/** Renders a message body with `@mention` tokens tinted. */
export function MentionText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <span className={cn("wrap-break-word", className)}>
      {splitMentions(text).map((part, i) =>
        part.type === "mention" ? (
          <span key={i} className="font-medium text-agent">
            {part.value}
          </span>
        ) : (
          <span key={i}>{part.value}</span>
        )
      )}
    </span>
  );
}
