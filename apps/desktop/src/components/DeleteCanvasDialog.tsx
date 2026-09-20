/**
 * Confirms removing a canvas from the catalog.
 *
 * The two modes are not variations on a theme, so the dialog does not try to
 * phrase them as one: deleting an offline canvas destroys the only copy, while
 * leaving an online one only changes who lists it. The heading, the body and
 * the button all say which of those is about to happen, and the invite code is
 * repeated for the online case because that is what brings the room back.
 */
import * as React from "react";
import { RiAlertLine, RiDeleteBinLine, RiLogoutBoxLine } from "@remixicon/react";

import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

export interface DeleteCanvasDialogProps {
  open: boolean;
  name: string;
  mode: "offline" | "online";
  inviteCode?: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteCanvasDialog({
  open,
  name,
  mode,
  inviteCode,
  busy,
  error,
  onConfirm,
  onCancel,
}: DeleteCanvasDialogProps) {
  const confirmRef = React.useRef<HTMLButtonElement>(null);
  const online = mode === "online";

  React.useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => confirmRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const Icon = online ? RiLogoutBoxLine : RiDeleteBinLine;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-canvas-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onCancel();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 animate-in fade-in duration-150"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl space-y-4 animate-in zoom-in-95 duration-150">
        <div className="flex items-center gap-2 text-foreground font-heading font-medium">
          <Icon className={online ? "size-5 text-primary" : "size-5 text-destructive"} />
          <h2 id="delete-canvas-title" className="text-base">
            {online ? "Leave this canvas?" : "Delete this canvas?"}
          </h2>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">
          {online ? (
            <>
              <span className="font-medium text-foreground">{name}</span> stays
              open for everyone else in the room — only your copy of the list
              changes.{" "}
              {inviteCode ? (
                <>
                  Rejoin any time with{" "}
                  <span className="font-mono uppercase text-primary">
                    {inviteCode}
                  </span>
                  .
                </>
              ) : (
                <>You can rejoin later with the invite code.</>
              )}
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">{name}</span> is
              stored only on this device. Its drawing and its chat history are
              deleted with it, and there is no way to get them back.
            </>
          )}
        </p>

        {error ? (
          <div className="flex items-start gap-2 p-2.5 border border-destructive/30 bg-destructive/10 text-destructive text-xs">
            <RiAlertLine className="size-4 shrink-0 mt-0.5" />
            <span className="leading-snug">{error}</span>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            variant={online ? "default" : "destructive"}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            className="gap-1.5"
          >
            {busy ? <Spinner className="size-3.5" /> : <Icon className="size-3.5" />}
            {online
              ? busy
                ? "Leaving..."
                : "Leave canvas"
              : busy
                ? "Deleting..."
                : "Delete canvas"}
          </Button>
        </div>
      </div>
    </div>
  );
}
