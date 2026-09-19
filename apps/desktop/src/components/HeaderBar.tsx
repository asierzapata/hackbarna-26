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
        className="header-bar__brand flex items-center gap-1.5 text-xs font-mono font-bold text-foreground/80 hover:text-foreground transition-colors"
        title="Back to all canvases"
      >
        <RiArrowLeftLine className="size-4" />
        <span>// KAN</span>
      </Link>

      {title ? (
        <div className="flex items-center gap-2 pl-2 border-l border-border">
          <span className="font-heading text-xs font-medium max-w-[200px] sm:max-w-[320px] truncate">
            {title}
          </span>
          {mode ? (
            <Badge
              variant={mode === "online" ? "default" : "secondary"}
              className="text-[10px] h-4 gap-1 px-1.5 uppercase font-mono font-semibold"
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
            className="text-xs h-7 gap-1.5 font-sans"
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
            className="text-xs h-7 gap-1.5 font-sans"
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
            title="Copy join code for collaborators"
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
