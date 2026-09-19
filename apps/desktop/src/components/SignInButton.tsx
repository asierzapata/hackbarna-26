import * as React from "react";
import {
  RiKey2Line,
  RiLogoutBoxRLine,
  RiSparkling2Line,
} from "@remixicon/react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { providerLabels, useAgent, type Provider } from "./agent-context";

const providers: Provider[] = ["devin", "openai"];

/**
 * Header control for the local agent runner. One button, then a choice of
 * provider and of credentials — a subscription signs in through the agent's own
 * CLI, a key is typed here and held for this run only.
 */
export function SignInButton() {
  const { status, signIn, signOut, busy } = useAgent();
  // Non-null while the key dialog is open, naming the provider it is for.
  const [keyFor, setKeyFor] = React.useState<Provider | null>(null);

  if (status.state === "ready") {
    const provider = status.providerLabel ?? "Agent";
    return (
      <div className="inline-flex items-center gap-0.5">
        {status.message && (
          <span
            role="alert"
            className="max-w-64 truncate text-xs text-destructive"
            title={status.message}
          >
            {status.message}
          </span>
        )}
        <span
          className="inline-flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium text-muted-foreground"
          data-testid="agent-status"
        >
          <span className="size-1.5 rounded-full bg-agent" aria-hidden />
          {status.agent ?? provider} · connected
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          // Stops the agent only; a subscription keeps its stored credentials.
          title={`Sign out of ${provider}`}
          aria-label={`Sign out of ${provider}`}
          disabled={busy}
          onClick={() => void signOut()}
          data-testid="agent-sign-out"
        >
          <RiLogoutBoxRLine />
        </Button>
      </div>
    );
  }

  if (status.state === "connecting") {
    return (
      <Button variant="outline" size="sm" disabled data-testid="sign-in-button">
        <Spinner className="size-3.5" />
        Connecting…
      </Button>
    );
  }

  // `unavailable` with a provider is a failed attempt, not a dead environment:
  // the menu stays usable so the next try is one click away.
  const failed = status.state === "unavailable" && !!status.provider;

  return (
    <div className="inline-flex items-center gap-2">
      {status.message && (
        <span
          className="max-w-64 truncate text-xs text-destructive"
          title={status.message ?? undefined}
          data-testid="agent-error"
        >
          {status.message}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              disabled={status.state === "unavailable" && !failed}
              title={status.message ?? undefined}
              data-testid="sign-in-button"
            />
          }
        >
          <RiSparkling2Line data-icon="inline-start" />
          Sign In
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuGroup>
            {providers.map((provider) => (
              <DropdownMenuSub key={provider}>
                <DropdownMenuSubTrigger data-testid={`sign-in-${provider}`}>
                  {providerLabels[provider]}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      onClick={() => void signIn(provider, "subscription")}
                      data-testid={`sign-in-${provider}-subscription`}
                    >
                      With Subscription
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setKeyFor(provider)}
                      data-testid={`sign-in-${provider}-api-key`}
                    >
                      With API Key
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {keyFor && (
        <ApiKeyDialog
          provider={keyFor}
          onClose={() => setKeyFor(null)}
          onSubmit={(key) => {
            setKeyFor(null);
            void signIn(keyFor, "api_key", key);
          }}
        />
      )}
    </div>
  );
}

function ApiKeyDialog({
  provider,
  onClose,
  onSubmit,
}: {
  provider: Provider;
  onClose: () => void;
  onSubmit: (key: string) => void;
}) {
  const [key, setKey] = React.useState("");
  const label = providerLabels[provider];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="api-key-dialog">
        <DialogHeader>
          <DialogTitle>Sign in to {label}</DialogTitle>
          <DialogDescription>
            {provider === "openai"
              ? "Saved in macOS Keychain so Kan can reconnect after a restart. The Codex adapter also caches the key in its own config. Sign out removes both copies."
              : "Saved securely in macOS Keychain so Kan can reconnect after a restart. Sign out removes the saved key."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim()) onSubmit(key.trim());
          }}
        >
          <Field>
            <FieldLabel htmlFor="api-key">{label} API key</FieldLabel>
            <Input
              id="api-key"
              type="password"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={provider === "openai" ? "sk-…" : "Personal API key"}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              data-testid="api-key-input"
            />
            <FieldDescription>
              {provider === "openai"
                ? "Billed to your OpenAI account, not your ChatGPT subscription."
                : "From your Devin account settings."}
            </FieldDescription>
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              disabled={!key.trim()}
              data-testid="api-key-submit"
            >
              <RiKey2Line data-icon="inline-start" />
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
