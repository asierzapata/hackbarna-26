import * as React from "react";
import {
  RiCornerDownLeftLine,
  RiImageAddLine,
  RiMicLine,
} from "@remixicon/react";

import { Badge } from "@/components/ui/badge";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import type { CanvasAnchor } from "@/lib/thread";

export interface ThreadComposerProps {
  /** Canvas nodes currently selected — the message will be anchored to them. */
  anchors?: CanvasAnchor[];
  placeholder?: string;
  disabled?: boolean;
  /** `files` carries pasted or picked images. */
  onSend?: (draft: { text: string; files: File[] }) => void;
  onAttach?: (files: File[]) => void;
  /** Toggle local mic capture; transcription lands back as transcript entries. */
  onToggleMic?: () => void;
  micActive?: boolean;
}

export function ThreadComposer({
  anchors = [],
  placeholder = "Message, or @assistant to ask…  (select nodes to anchor)",
  disabled,
  onSend,
  onAttach,
  onToggleMic,
  micActive,
}: ThreadComposerProps) {
  const [text, setText] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const canSend = !disabled && (text.trim().length > 0 || files.length > 0);

  function send() {
    if (!canSend) return;
    onSend?.({ text: text.trim(), files });
    setText("");
    setFiles([]);
  }

  function addFiles(incoming: File[]) {
    if (!incoming.length) return;
    setFiles((prev) => [...prev, ...incoming]);
    onAttach?.(incoming);
  }

  return (
    <InputGroup className="bg-muted">
      <InputGroupAddon align="block-start" className="justify-between">
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
        onPaste={(event) => {
          const pasted = Array.from(event.clipboardData.files);
          if (pasted.length) {
            event.preventDefault();
            addFiles(pasted);
          }
        }}
      />

      <InputGroupAddon align="block-end" className="justify-between">
        <span className="flex items-center gap-1">
          <InputGroupButton
            size="icon-xs"
            aria-label="Attach an image"
            onClick={() => fileInput.current?.click()}
          >
            <RiImageAddLine />
          </InputGroupButton>
          <InputGroupButton
            size="icon-xs"
            aria-label={micActive ? "Stop transcribing" : "Start transcribing"}
            aria-pressed={micActive}
            className={micActive ? "text-agent" : undefined}
            onClick={onToggleMic}
          >
            <RiMicLine />
          </InputGroupButton>
          {files.length ? (
            <span className="text-muted-foreground">
              {files.length} attached
            </span>
          ) : null}
        </span>

        <InputGroupButton
          variant="default"
          size="xs"
          disabled={!canSend}
          onClick={send}
        >
          Send
        </InputGroupButton>
      </InputGroupAddon>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
    </InputGroup>
  );
}
