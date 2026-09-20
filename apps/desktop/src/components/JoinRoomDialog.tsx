import * as React from "react";
import { RiLoginBoxLine, RiAlertLine } from "@remixicon/react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { joinServerRoom } from "@/lib/api-client";
import { markCanvasOnline } from "@/lib/canvas-repository";

export interface JoinRoomDialogProps {
  open: boolean;
  onClose: () => void;
  onJoined: (roomId: string) => void;
}

export function JoinRoomDialog({ open, onClose, onJoined }: JoinRoomDialogProps) {
  const [code, setCode] = React.useState("");
  const [isJoining, setIsJoining] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setCode("");
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError("Please enter an invite code");
      return;
    }

    setIsJoining(true);
    setError(null);

    try {
      const result = await joinServerRoom(trimmed);
      const room = result.room;
      // Mark or register joined room in catalog
      await markCanvasOnline(room.localCanvasId, room.id, room.code);
      onJoined(room.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join canvas");
    } finally {
      setIsJoining(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="join-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 animate-in fade-in duration-150"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl space-y-4 animate-in zoom-in-95 duration-150">
        <div className="flex items-center gap-2 text-foreground font-heading font-medium">
          <RiLoginBoxLine className="size-5 text-primary" />
          <h2 id="join-dialog-title" className="text-base">
            Join a Canvas
          </h2>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">
          Enter the invite code a collaborator shared with you to open their canvas
          and edit together.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="join-code-input" className="text-sm font-sans font-medium text-foreground">
              Invite code
            </label>
            <Input
              ref={inputRef}
              id="join-code-input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. 7K2M9-XP4TR"
              disabled={isJoining}
              className="font-mono uppercase tracking-wider text-sm"
              autoComplete="off"
            />
          </div>

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
              onClick={onClose}
              disabled={isJoining}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={isJoining || !code.trim()}
              className="gap-1.5"
            >
              {isJoining ? <Spinner className="size-3.5" /> : <RiLoginBoxLine className="size-3.5" />}
              {isJoining ? "Joining..." : "Join"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
