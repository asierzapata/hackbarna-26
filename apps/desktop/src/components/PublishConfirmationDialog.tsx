import { RiCloudLine, RiAlertLine } from "@remixicon/react";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

export interface PublishConfirmationDialogProps {
  open: boolean;
  isPublishing?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PublishConfirmationDialog({
  open,
  isPublishing = false,
  error,
  onConfirm,
  onCancel,
}: PublishConfirmationDialogProps) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 animate-in fade-in duration-150"
    >
      <div className="w-full max-w-md border border-border bg-card p-6 shadow-xl space-y-4 animate-in zoom-in-95 duration-150">
        <div className="flex items-center gap-2 text-foreground font-heading font-medium">
          <RiCloudLine className="size-5 text-primary" />
          <h2 id="publish-dialog-title" className="text-base">
            Make this canvas online?
          </h2>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">
          Your canvas will be saved online so you can share it and edit together. It will stay
          online. You can duplicate it into a separate offline canvas anytime.
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
            disabled={isPublishing}
          >
            Keep offline
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onConfirm}
            disabled={isPublishing}
            className="gap-1.5"
          >
            {isPublishing ? <Spinner className="size-3.5" /> : <RiCloudLine className="size-3.5" />}
            {isPublishing ? "Making online..." : "Make online"}
          </Button>
        </div>
      </div>
    </div>
  );
}
