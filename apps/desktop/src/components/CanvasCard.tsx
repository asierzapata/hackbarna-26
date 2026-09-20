/**
 * One canvas in the catalog grid.
 *
 * The preview is whatever the last editing session rendered, so a canvas this
 * device has never opened has none. Rather than an empty hole, those fall back
 * to a tinted monogram keyed off the name, which at least stays stable between
 * visits and reads as "not yet opened" rather than "empty".
 */
import * as React from "react";
import {
  RiCheckLine,
  RiCloseLine,
  RiCloudLine,
  RiEditLine,
  RiFileCopyLine,
  RiHardDriveLine,
  RiTimeLine,
} from "@remixicon/react";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { cn } from "@/lib/utils";

export interface CanvasCardItem {
  /** Route parameter: the canvas id offline, the room id online. */
  id: string;
  name: string;
  mode: "offline" | "online";
  lastActivity: string;
  inviteCode?: string;
  thumbnail?: string;
}

export interface CanvasCardProps {
  item: CanvasCardItem;
  formatDate: (iso: string) => string;
  onOpen: () => void;
  onRename: () => void;
  /** Offline copy of an online canvas. Absent for canvases already offline. */
  onDuplicate?: () => void;
  isDuplicating?: boolean;
  isRenaming?: boolean;
  /** When set, the title is replaced by this editor. */
  renameEditor?: React.ReactNode;
}

const MONOGRAM_TINTS = [
  "bg-primary/10 text-primary",
  "bg-emerald-500/10 text-emerald-600",
  "bg-amber-500/10 text-amber-600",
  "bg-violet-500/10 text-violet-600",
  "bg-sky-500/10 text-sky-600",
  "bg-rose-500/10 text-rose-600",
];

function tintFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return MONOGRAM_TINTS[hash % MONOGRAM_TINTS.length];
}

function monogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function CanvasCard({
  item,
  formatDate,
  onOpen,
  onRename,
  onDuplicate,
  isDuplicating = false,
  isRenaming = false,
  renameEditor,
}: CanvasCardProps) {
  const online = item.mode === "online";

  return (
    <article
      className="group flex flex-col border border-border bg-card transition-colors hover:border-foreground/30"
      aria-label={item.name}
      data-mode={item.mode}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${item.name}`}
        className="relative block aspect-4/3 w-full overflow-hidden border-b border-border bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {item.thumbnail ? (
          <img
            src={item.thumbnail}
            alt=""
            className="size-full object-cover object-top"
            draggable={false}
          />
        ) : (
          <span
            aria-hidden
            className={cn(
              "flex size-full items-center justify-center font-heading text-2xl font-bold",
              tintFor(item.name),
            )}
          >
            {monogram(item.name)}
          </span>
        )}

        <span
          className={cn(
            "absolute left-2 top-2 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wide",
            online
              ? "bg-primary text-primary-foreground"
              : "bg-background/90 text-muted-foreground",
          )}
        >
          {online ? (
            <RiCloudLine className="size-3" />
          ) : (
            <RiHardDriveLine className="size-3" />
          )}
          {online ? "Online" : "Offline"}
        </span>
      </button>

      <div className="flex min-w-0 flex-col gap-1 p-3">
        {renameEditor ?? (
          <button
            type="button"
            onClick={onOpen}
            className="truncate text-left font-heading text-xs font-medium text-foreground hover:underline"
            title={item.name}
          >
            {item.name}
          </button>
        )}

        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <RiTimeLine className="size-3 shrink-0" />
          <span className="truncate">{formatDate(item.lastActivity)}</span>
          {item.inviteCode ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate uppercase text-primary/90">
                {item.inviteCode}
              </span>
            </>
          ) : null}
        </div>

        <div className="mt-1 flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={onRename}
            disabled={isRenaming}
            className="gap-1 text-[11px]"
          >
            <RiEditLine className="size-3" />
            Rename
          </Button>

          {onDuplicate ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={onDuplicate}
              disabled={isDuplicating}
              className="gap-1 text-[11px]"
              title="Create an independent offline copy"
            >
              {isDuplicating ? (
                <Spinner className="size-3" />
              ) : (
                <RiFileCopyLine className="size-3" />
              )}
              Copy offline
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/** Shared by both the card title and the rename form, so Escape behaves once. */
export function CanvasRenameEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  error,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <form className="flex min-w-0 flex-wrap items-center gap-1" onSubmit={onSubmit}>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        aria-label="Canvas name"
        aria-invalid={Boolean(error)}
        autoFocus
        maxLength={120}
        disabled={busy}
        className="h-6 w-0 min-w-0 flex-1 font-heading"
      />
      <Button
        type="submit"
        size="icon-xs"
        variant="ghost"
        aria-label="Save canvas name"
        title="Save canvas name"
        disabled={busy}
      >
        <RiCheckLine />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Cancel renaming"
        title="Cancel renaming"
        onClick={onCancel}
        disabled={busy}
      >
        <RiCloseLine />
      </Button>
      {error ? (
        <p className="basis-full text-[10px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
