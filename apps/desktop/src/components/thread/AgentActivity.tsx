import * as React from "react";
import { RiArrowDownSLine, RiCheckLine, RiErrorWarningLine } from "@remixicon/react";
import { cn } from "cn";

import { Spinner } from "@/components/ui/spinner";
import { activityLabel, summaryLabel } from "@/lib/agent-steps";
import type { AgentStep } from "@/lib/thread";

import { AnchorChip } from "./AnchorChip";
import { useThread } from "./thread-context";

/**
 * What the agent is doing, inside its own bubble.
 *
 * While the turn runs this is the loudest thing in the panel: a live status
 * line, one row per tool call, and a single line of the agent's reasoning.
 * Once it ends it collapses to `Worked for 6.1s · 5 steps`, because past steps
 * are evidence, not conversation. A failed turn stays open — that is the one
 * case where the detail is the point.
 */
export function AgentActivity({
  steps = [],
  thought,
  thinking = false,
  running = false,
  durationMs,
}: {
  steps?: AgentStep[];
  thought?: string;
  /** Reasoning is streaming, even before a whole sentence is ready to show. */
  thinking?: boolean;
  running?: boolean;
  durationMs?: number;
}) {
  const failed = steps.some((step) => step.state === "error");
  const [open, setOpen] = React.useState(false);
  const expanded = running || open || failed;

  // A direct canvas result never calls a model, so it has nothing to report
  // and should not flash an empty rail on its way past.
  if (!running && steps.length === 0) return null;

  return (
    <div data-testid="agent-activity" className="flex flex-col gap-1.5">
      {running ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="agent-activity-status"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Spinner className="size-3 shrink-0" aria-hidden />
          <span className="shimmer">{activityLabel(steps, thinking || !!thought)}</span>
        </div>
      ) : (
        <button
          type="button"
          data-testid="agent-activity-summary"
          aria-expanded={expanded}
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
        >
          <RiArrowDownSLine
            aria-hidden
            className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")}
          />
          {summaryLabel(steps, durationMs)}
        </button>
      )}

      {expanded && steps.length ? (
        <ol className="ms-1 flex flex-col gap-1 border-s border-border ps-3">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ol>
      ) : null}

      {running && thought ? (
        <p
          data-testid="agent-thought"
          className="ms-1 border-s border-border ps-3 text-xs leading-relaxed text-muted-foreground/80 italic"
        >
          {thought}
        </p>
      ) : null}
    </div>
  );
}

function StepRow({ step }: { step: AgentStep }) {
  const { onJumpToNode } = useThread();
  return (
    <li
      data-testid="agent-step"
      data-state={step.state ?? "done"}
      className="flex items-center gap-2 text-xs text-muted-foreground"
    >
      <StepIcon state={step.state} />
      <span className={cn("min-w-0 truncate", step.state === "error" && "text-destructive")}>
        {step.summary}
      </span>
      {step.target ? <AnchorChip anchor={step.target} onJump={onJumpToNode} /> : null}
      <span className="ms-auto shrink-0 tabular-nums text-xs text-muted-foreground/70">
        {step.state === "error"
          ? (step.error ?? "failed")
          : typeof step.durationMs === "number"
            ? `${(step.durationMs / 1000).toFixed(1)}s`
            : ""}
      </span>
    </li>
  );
}

function StepIcon({ state }: { state: AgentStep["state"] }) {
  if (state === "running") return <Spinner className="size-3 shrink-0" aria-hidden />;
  if (state === "error")
    return <RiErrorWarningLine aria-hidden className="size-3 shrink-0 text-destructive" />;
  if (state === "pending")
    return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-border" />;
  return <RiCheckLine aria-hidden className="size-3 shrink-0 text-agent" />;
}
