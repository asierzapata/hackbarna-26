import * as React from "react";
import { RiCornerDownLeftLine } from "@remixicon/react";

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

export interface ThreadComposerProps {
  /** Canvas nodes currently selected — the message will be anchored to them. */
  anchors?: CanvasAnchor[];
  placeholder?: string;
  replyTo?: { id: string; label: string };
  onClearReply?: () => void;
  disabled?: boolean;
  /** `files` remains part of the transport draft for compatibility; the composer no longer uploads files. */
  onSend?: (draft: { text: string; files: File[]; replyToEntryId?: string }) => void;
  models?: AiModel[];
  modelDisabled?: boolean;
  modelSelection?: AiModelSelection;
  onModelSelectionChange?: (selection: AiModelSelection) => void;
}

export function ThreadComposer({
  anchors = [],
  placeholder = "Message the room · @kan to ask Kan",
  replyTo,
  onClearReply,
  disabled,
  onSend,
  modelSelection,
  models,
  modelDisabled,
  onModelSelectionChange,
}: ThreadComposerProps) {
  const [text, setText] = React.useState("");
  const canSend = !disabled && text.trim().length > 0;

  function send() {
    if (!canSend) return;
    onSend?.({ text: text.trim(), files: [], replyToEntryId: replyTo?.id });
    onClearReply?.();
    setText("");
  }

  return (
    <InputGroup className="bg-muted">
      <InputGroupAddon align="block-start" className="justify-between">
        {replyTo ? <Button variant="outline" size="xs" onClick={onClearReply}>Replying to {replyTo.label}</Button> : null}
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
            send();
          }
        }}
      />

      {modelSelection ? (
        <InputGroupAddon align="block-end" className="justify-end">
          <ModelSelectorKit
            models={models ?? []}
            disabled={modelDisabled}
            value={modelSelection}
            onValueChange={onModelSelectionChange}
            className="min-w-0"
            aria-label="Choose chat model"
          />
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}
