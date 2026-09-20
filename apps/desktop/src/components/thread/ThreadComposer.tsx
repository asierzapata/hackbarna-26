import * as React from "react";
import { RiCornerDownLeftLine, RiSparkling2Line } from "@remixicon/react";
import { explicitInvocation } from "@kan/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import {
  ModelSelectorKit,
  type AiModelSelection,
  type AiModel,
} from "@/components/ui/ai-model-select";
import type { CanvasAnchor } from "@/lib/thread";
import { useQaSource } from "@/lib/qa-source";

export interface ThreadComposerProps {
  /** Canvas nodes currently selected — the message will be anchored to them. */
  anchors?: CanvasAnchor[];
  placeholder?: string;
  replyTo?: { id: string; label: string };
  onClearReply?: () => void;
  disabled?: boolean;
  /** `files` remains part of the transport draft for compatibility; the composer no longer uploads files. */
  onSend?: (draft: { text: string; files: File[]; replyToEntryId?: string }) => void;
  /** Whether asking Kan is possible at all — no agent connected, no button. */
  agentReady?: boolean;
  models?: AiModel[];
  modelDisabled?: boolean;
  modelSelection?: AiModelSelection;
  onModelSelectionChange?: (selection: AiModelSelection) => void;
}

export function ThreadComposer({
  anchors = [],
  placeholder = "Message the canvas · Ask Kan (⌘↵) to bring in the assistant",
  replyTo,
  onClearReply,
  disabled,
  onSend,
  agentReady = false,
  modelSelection,
  models,
  modelDisabled,
  onModelSelectionChange,
}: ThreadComposerProps) {
  const [text, setText] = React.useState("");
  useQaSource("composer", () => ({ text, anchors, disabled, agentReady, modelSelection }));
  const canSend = !disabled && text.trim().length > 0;

  /**
   * Sends the draft, optionally as an explicit request to Kan.
   *
   * `@kan` is the one thing that wakes the assistant up, and a room full of
   * people typing plain sentences has no way to discover that. Rather than
   * teach the transports a second entry point, the button writes the prefix
   * the user would have had to remember: one path in, still visible in the
   * thread as the words that asked.
   */
  function send(explicit = false) {
    if (!canSend) return;
    const trimmed = text.trim();
    const body = explicit && !explicitInvocation(trimmed) ? `@kan ${trimmed}` : trimmed;
    onSend?.({ text: body, files: [], replyToEntryId: replyTo?.id });
    onClearReply?.();
    setText("");
  }

  return (
    <InputGroup className="bg-muted">
      <InputGroupAddon align="block-start" className="justify-between">
        {replyTo ? (
          <Button variant="outline" size="xs" onClick={onClearReply}>
            Replying to {replyTo.label}
          </Button>
        ) : null}
        {anchors.length ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            <Badge variant="outline" className="border-agent text-agent">
              {anchors.length} node{anchors.length === 1 ? "" : "s"} selected (
              {anchors.map((a) => a.label).join(", ")})
            </Badge>
          </span>
        ) : (
          <span className="text-muted-foreground">no canvas anchor</span>
        )}
        <Kbd>
          <RiCornerDownLeftLine />
        </Kbd>
      </InputGroupAddon>

      <InputGroupTextarea
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        rows={2}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send(event.metaKey || event.ctrlKey);
          }
        }}
      />

      <InputGroupAddon align="block-end" className="justify-between gap-2">
        {modelSelection ? (
          <ModelSelectorKit
            models={models ?? []}
            disabled={modelDisabled}
            value={modelSelection}
            onValueChange={onModelSelectionChange}
            className="min-w-0"
            aria-label="Choose chat model"
          />
        ) : (
          <span />
        )}
        <span className="flex items-center gap-2">
          {agentReady ? (
            <Button size="sm" disabled={!canSend} onClick={() => send(true)}>
              <RiSparkling2Line data-icon="inline-start" />
              Ask Kan
            </Button>
          ) : null}
          <Button variant="outline" size="sm" disabled={!canSend} onClick={() => send()}>
            Send
          </Button>
        </span>
      </InputGroupAddon>
    </InputGroup>
  );
}
