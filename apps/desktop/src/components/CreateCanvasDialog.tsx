/**
 * The mode choice, made up front instead of after the fact.
 *
 * Every canvas used to be born offline and could only become online later, via
 * publish. That is still the underlying mechanic — an online canvas here is an
 * empty local one that is published immediately — but the choice now happens
 * where the user is already thinking about it.
 *
 * Reachability is probed when the dialog opens rather than on the catalog, so
 * an installation that never goes online never pings the backend just for
 * sitting on the home screen. Online is preselected — it is what most canvases
 * want to be — and falls back to offline if the probe says the server is gone.
 */
import * as React from "react";
import {
  RiAddLine,
  RiAlertLine,
  RiCloudLine,
  RiHardDriveLine,
} from "@remixicon/react";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { checkServerReachable } from "@/lib/api-client";
import { createCanvas, type CanvasMode, type CreatedCanvas } from "@/lib/create-canvas";
import { cn } from "@/lib/utils";

export interface CreateCanvasDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (canvas: CreatedCanvas) => void;
}

type Reachability = "checking" | "reachable" | "unreachable";

interface ModeCardProps {
  mode: CanvasMode;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  note?: string;
  icon: React.ReactNode;
}

function ModeCard({
  mode,
  selected,
  disabled,
  onSelect,
  title,
  description,
  note,
  icon,
}: ModeCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={title}
      data-mode={mode}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex flex-1 flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-primary bg-primary/5"
          : "border-border bg-background hover:bg-muted/50",
        disabled && "cursor-not-allowed opacity-50 hover:bg-background",
      )}
    >
      <span className="flex items-center gap-1.5 font-heading text-xs font-semibold text-foreground">
        {icon}
        {title}
      </span>
      <span className="text-xs leading-snug text-muted-foreground">
        {description}
      </span>
      {note ? (
        <span className="text-xs font-mono uppercase tracking-wide text-muted-foreground/80">
          {note}
        </span>
      ) : null}
    </button>
  );
}

export function CreateCanvasDialog({
  open,
  onClose,
  onCreated,
}: CreateCanvasDialogProps) {
  const [name, setName] = React.useState("Untitled Canvas");
  const [mode, setMode] = React.useState<CanvasMode>("online");
  const [reachability, setReachability] =
    React.useState<Reachability>("checking");
  const [isCreating, setIsCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;

    setName("Untitled Canvas");
    setMode("online");
    setError(null);
    setIsCreating(false);
    setReachability("checking");

    const focusTimer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);

    let active = true;
    void checkServerReachable().then((ok) => {
      if (active) setReachability(ok ? "reachable" : "unreachable");
    });

    return () => {
      active = false;
      clearTimeout(focusTimer);
    };
  }, [open]);

  const onlineAvailable = reachability === "reachable";

  // A probe that resolves after the user has already picked online must not
  // leave an unselectable card selected.
  React.useEffect(() => {
    if (reachability === "unreachable" && mode === "online") setMode("offline");
  }, [reachability, mode]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Canvas name cannot be empty");
      return;
    }
    if (mode === "online" && !onlineAvailable) return;

    setIsCreating(true);
    setError(null);
    try {
      onCreated(await createCanvas(mode, trimmed));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create the canvas",
      );
      setIsCreating(false);
    }
  };

  if (!open) return null;

  const onlineNote =
    reachability === "checking"
      ? "Checking the server…"
      : onlineAvailable
        ? undefined
        : "Server unreachable — try again when you are connected";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-canvas-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isCreating) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 animate-in fade-in duration-150"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl space-y-4 animate-in zoom-in-95 duration-150">
        <div className="flex items-center gap-2 text-foreground font-heading font-medium">
          <RiAddLine className="size-5 text-primary" />
          <h2 id="create-canvas-title" className="text-base">
            New canvas
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="create-canvas-name"
              className="text-sm font-sans font-medium text-foreground"
            >
              Name
            </label>
            <Input
              ref={inputRef}
              id="create-canvas-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              disabled={isCreating}
              autoComplete="off"
              className="text-sm"
            />
          </div>

          <div
            className="space-y-1.5"
            role="radiogroup"
            aria-label="Where this canvas lives"
          >
            <span className="text-sm font-sans font-medium text-foreground">
              Where it lives
            </span>
            <div className="flex items-stretch gap-2">
              <ModeCard
                mode="offline"
                selected={mode === "offline"}
                disabled={isCreating}
                onSelect={() => setMode("offline")}
                title="Offline"
                description="Saved on this device. Private, works with no connection."
                icon={<RiHardDriveLine className="size-3.5" />}
              />
              <ModeCard
                mode="online"
                selected={mode === "online"}
                disabled={isCreating || reachability === "unreachable"}
                onSelect={() => setMode("online")}
                title="Online"
                description="Shared through the server. Invite people to edit and call."
                note={onlineNote}
                icon={
                  reachability === "checking" ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <RiCloudLine className="size-3.5" />
                  )
                }
              />
            </div>
            <p className="text-xs leading-snug text-muted-foreground">
              {mode === "online"
                ? "An online canvas stays online. You can always duplicate it into a separate offline copy."
                : "You can make an offline canvas online later, but not the other way around."}
            </p>
          </div>

          {error ? (
            <div
              role="alert"
              className="flex items-start gap-2 p-2.5 border border-destructive/30 bg-destructive/10 text-destructive text-xs"
            >
              <RiAlertLine className="size-4 shrink-0 mt-0.5" />
              <span className="leading-snug">{error}</span>
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={isCreating || !name.trim() || (mode === "online" && !onlineAvailable)}
              className="gap-1.5"
            >
              {isCreating ? (
                <Spinner className="size-3.5" />
              ) : (
                <RiAddLine className="size-3.5" />
              )}
              {isCreating
                ? mode === "online"
                  ? "Creating online…"
                  : "Creating…"
                : "Create canvas"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
