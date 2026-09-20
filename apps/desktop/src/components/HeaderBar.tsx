import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  RiArrowLeftLine,
  RiCloudLine,
  RiHardDriveLine,
  RiFileCopyLine,
  RiShareLine,
  RiCheckLine,
} from "@remixicon/react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Spinner } from "./ui/spinner";
import { SignInButton } from "./SignInButton";
import { KanBrand } from "./KanBrand";

export interface HeaderBarProps {
  title?: string;
  mode?: "offline" | "online";
  roomCode?: string;
  onMakeOnline?: () => void;
  onDuplicateOffline?: () => void;
  isPublishing?: boolean;
}

export function HeaderBar({
  title,
  mode,
  roomCode,
  onMakeOnline,
  onDuplicateOffline,
  isPublishing = false,
}: HeaderBarProps) {
  const [copied, setCopied] = React.useState(false);

  const handleCopyCode = React.useCallback(() => {
    if (!roomCode) return;
    void navigator.clipboard?.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [roomCode]);

  return (
    <header className="header-bar">
      <Link
        to="/"
        className="header-bar__brand flex items-center gap-2 text-sm font-sans font-semibold text-muted-foreground hover:text-foreground transition-colors"
        title="Back to all canvases"
        aria-label="Back to all canvases"
      >
        <RiArrowLeftLine className="size-4" />
        <KanBrand />
      </Link>

      {title ? (
        <div className="flex min-w-0 items-center gap-3 border-l border-border pl-4">
          <span className="max-w-[200px] truncate font-sans text-base font-semibold tracking-tight sm:max-w-[320px]">
            {title}
          </span>
          {mode ? (
            <Badge
              variant="secondary"
              className="h-5 shrink-0 gap-1 px-1.5"
            >
              {mode === "online" ? (
                <>
                  <RiCloudLine className="size-3" /> Online
                </>
              ) : (
                <>
                  <RiHardDriveLine className="size-3" /> Offline
                </>
              )}
            </Badge>
          ) : null}
        </div>
      ) : null}

      <div className="header-bar__slot" />
      <div className="flex items-center gap-2">
        {mode === "offline" && onMakeOnline ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onMakeOnline}
            disabled={isPublishing}
            className="h-7 gap-1.5"
          >
            {isPublishing ? <Spinner className="size-3.5" /> : <RiCloudLine className="size-3.5" />}
            {isPublishing ? "Publishing..." : "Make online"}
          </Button>
        ) : null}

        {mode === "online" && onDuplicateOffline ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onDuplicateOffline}
            className="h-7 gap-1.5"
            title="Create an independent offline copy"
          >
            <RiFileCopyLine className="size-3.5" />
            Duplicate offline
          </Button>
        ) : null}

        {mode === "online" && roomCode ? (
          <Button
            size="sm"
            variant="outline"
            onClick={handleCopyCode}
            className="text-xs h-7 gap-1.5 font-mono"
            title="Copy the invite code for collaborators"
          >
            {copied ? <RiCheckLine className="size-3.5 text-green-600" /> : <RiShareLine className="size-3.5" />}
            {copied ? "Copied" : roomCode}
          </Button>
        ) : null}

        <SignInButton />
      </div>
    </header>
  );
}
