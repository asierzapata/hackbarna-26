import {
  RiAddLine,
  RiArrowRightLine,
  RiArrowRightSLine,
  RiDatabase2Line,
  RiEdit2Line,
  RiLink,
  RiSearchLine,
  RiTerminalBoxLine,
} from "@remixicon/react";
import type { RemixiconComponentType } from "@remixicon/react";
import { cn } from "cn";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Message, MessageContent } from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import type { AgentEntry, AgentStep } from "@/lib/thread";
import { formatDuration } from "@/lib/thread";

import { useAuthor, useThread } from "./thread-context";

/**
 * Icons for the tools we know about. Unknown tools fall back to a generic
 * terminal glyph, so an agent gaining a new capability needs no UI change.
 */
const stepIcons: Record<string, RemixiconComponentType> = {
  queryData: RiSearchLine,
  addNode: RiAddLine,
  editNode: RiEdit2Line,
  linkNodes: RiLink,
  readCanvas: RiDatabase2Line,
};

function AgentStepRow({ step }: { step: AgentStep }) {
  const { onJumpToNode } = useThread();
  const Icon = stepIcons[step.tool] ?? RiTerminalBoxLine;

  return (
    <div
      className={cn(
        "flex items-center gap-2 border border-border bg-muted px-2 py-1.5 text-xs",
        step.state === "error" && "border-destructive/40 text-destructive"
      )}
    >
      {step.state === "running" ? (
        <Spinner className="size-3.5 shrink-0" />
      ) : (
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="shrink-0 font-medium">{step.tool}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-muted-foreground",
          step.state === "running" && "shimmer"
        )}
      >
        {step.summary}
      </span>
      {step.target && onJumpToNode ? (
        <Button
          variant="link"
          size="xs"
          className="shrink-0 text-agent"
          onClick={() => onJumpToNode(step.target!)}
        >
          jump
          <RiArrowRightLine data-icon="inline-end" />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One agent turn. Every participant runs their own local agent, so the header
 * names the agent and — when it differs from the author — who it belongs to.
 */
export function AgentEntryCard({ entry }: { entry: AgentEntry }) {
  const agent = useAuthor(entry.authorId);
  const { participants } = useThread();
  const operator = entry.authorId
    ? agent.operatorId
      ? participants[agent.operatorId]
      : undefined
    : undefined;

  const steps = entry.steps ?? [];
  const visibleCount = entry.visibleSteps ?? 2;
  const shown = steps.slice(0, visibleCount);
  const hidden = steps.slice(visibleCount);

  const meta = [
    entry.model ? `via ${entry.model}` : null,
    entry.durationMs !== undefined ? formatDuration(entry.durationMs) : null,
  ].filter(Boolean);

  return (
    <Message align="start">
      <MessageContent>
        <Bubble
          variant="ghost"
          className="w-full border-2 border-solid border-agent bg-background p-3"
        >
          <BubbleContent className="flex w-full flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full bg-agent"
              />
              <span className="min-w-0 truncate font-medium text-agent">
                {agent.name}
              </span>
              {operator ? (
                <span className="shrink-0 text-muted-foreground">
                  · {operator.name}&apos;s
                </span>
              ) : null}
              {meta.length ? (
                <span className="ms-auto shrink-0 text-muted-foreground">
                  {meta.join(" · ")}
                </span>
              ) : null}
            </div>

            <p
              className={cn(
                "text-xs leading-relaxed wrap-break-word",
                entry.streaming && "shimmer"
              )}
            >
              {entry.text}
            </p>

            {steps.length ? (
              <div className="flex flex-col gap-1.5">
                {shown.map((step) => (
                  <AgentStepRow key={step.id} step={step} />
                ))}

                {hidden.length ? (
                  <Collapsible className="flex flex-col gap-1.5">
                    <CollapsibleTrigger className="group/steps flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                      <RiArrowRightSLine className="size-3.5 transition-transform group-data-[panel-open]/steps:rotate-90" />
                      {hidden.length} more {hidden.length === 1 ? "step" : "steps"}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="flex flex-col gap-1.5">
                      {hidden.map((step) => (
                        <AgentStepRow key={step.id} step={step} />
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                ) : null}
              </div>
            ) : null}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
