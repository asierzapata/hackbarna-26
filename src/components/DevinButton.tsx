import { RiLogoutBoxRLine, RiSparkling2Line } from "@remixicon/react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useDevin } from "./devin-context";

/**
 * Header control for the local agent runner. Two clicks at most: the first
 * starts `devin acp` and asks it whether it has credentials, the second runs
 * the browser login if it doesn't.
 */
export function DevinButton() {
  const { status, connect, login, disconnect, busy } = useDevin();

  if (status.state === "ready") {
    return (
      <div className="inline-flex items-center gap-0.5">
        <span
          className="inline-flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium text-muted-foreground"
          data-testid="devin-status"
        >
          <span className="size-1.5 rounded-full bg-agent" aria-hidden />
          {status.agent ?? "Devin"} · connected
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          // Stops the agent only; the CLI keeps its credentials.
          title="Disconnect Devin"
          aria-label="Disconnect Devin"
          disabled={busy}
          onClick={() => void disconnect()}
          data-testid="devin-disconnect"
        >
          <RiLogoutBoxRLine />
        </Button>
      </div>
    );
  }

  if (status.state === "connecting") {
    return (
      <Button variant="outline" size="sm" disabled data-testid="devin-button">
        <Spinner className="size-3.5" />
        Connecting…
      </Button>
    );
  }

  const needsLogin = status.state === "needs_login";

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={status.state === "unavailable"}
      title={status.message ?? undefined}
      onClick={() => void (needsLogin ? login() : connect())}
      data-testid="devin-button"
    >
      <RiSparkling2Line data-icon="inline-start" />
      {needsLogin ? "Log in with browser" : "Use my Devin"}
    </Button>
  );
}
