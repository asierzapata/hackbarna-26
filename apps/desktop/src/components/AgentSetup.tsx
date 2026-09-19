import * as React from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  useAgent,
  providerLabels,
  type Provider,
  type AuthMode,
} from "./agent-context";
import { Button } from "./ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "./ui/field";
import { Input } from "./ui/input";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { ModelSelectorKit } from "./ui/ai-model-select";
import { Spinner } from "./ui/spinner";

export function AgentSetup() {
  const agent = useAgent();
  const [provider, setProvider] = React.useState<Provider>("devin");
  const [mode, setMode] = React.useState<AuthMode>("subscription");
  const [key, setKey] = React.useState("");
  const [edited, setEdited] = React.useState(false);
  const pending = agent.status.state === "connecting" || agent.busy;
  const ready = agent.status.state === "ready";
  const models = agent.status.models;

  React.useEffect(() => {
    if (edited || !agent.preferences) return;
    setProvider(agent.preferences.provider ?? "devin");
    setMode(agent.preferences.mode ?? "subscription");
  }, [agent.preferences, edited]);

  return (
    <FieldGroup data-testid="agent-setup">
      {ready ? (
        <>
          <Field>
            <FieldLabel>Connected to {agent.status.providerLabel}</FieldLabel>
            <FieldDescription>
              {agent.status.mode === "api_key"
                ? "API key saved in macOS Keychain."
                : "Using your subscription."}{" "}
              Kan will reconnect when you reopen the app.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Default model</FieldLabel>
            {models?.available.length ? (
              <ModelSelectorKit
                models={models.available}
                value={{ id: models.current ?? "" }}
                onValueChange={(selection) => {
                  void agent.setModel(selection.id);
                }}
                disabled={pending}
                aria-label="Choose default model"
              />
            ) : (
              <FieldDescription>
                This provider does not expose a model picker. Its default model
                will be used.
              </FieldDescription>
            )}
            <FieldDescription>
              Your choice applies to new sessions and is remembered after a
              restart. You can change it in chat.
            </FieldDescription>
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              void agent.signOut();
            }}
          >
            Change account
          </Button>
        </>
      ) : (
        <>
          <Field>
            <FieldLabel id="provider-label">AI provider</FieldLabel>
            <ToggleGroup
              aria-labelledby="provider-label"
              variant="outline"
              value={[provider]}
              disabled={pending}
              onValueChange={(values) => {
                if (values[0]) {
                  setProvider(values[0] as Provider);
                  setKey("");
                  setEdited(true);
                }
              }}
            >
              <ToggleGroupItem value="devin">Devin</ToggleGroupItem>
              <ToggleGroupItem value="openai">OpenAI</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel id="auth-label">
              How would you like to sign in?
            </FieldLabel>
            <ToggleGroup
              aria-labelledby="auth-label"
              variant="outline"
              value={[mode]}
              disabled={pending}
              onValueChange={(values) => {
                if (values[0]) {
                  setMode(values[0] as AuthMode);
                  setKey("");
                  setEdited(true);
                }
              }}
            >
              <ToggleGroupItem value="subscription">
                Subscription
              </ToggleGroupItem>
              <ToggleGroupItem value="api_key">API key</ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription>
              {mode === "subscription"
                ? `Use your ${provider === "openai" ? "ChatGPT" : "Devin"} subscription. We reuse your saved login, or open the provider's sign-in flow.`
                : "Your key is saved in macOS Keychain, never in browser storage. Sign out removes the saved key."}
            </FieldDescription>
          </Field>
          {mode === "api_key" && (
            <Field>
              <FieldLabel htmlFor="onboarding-api-key">
                {providerLabels[provider]} API key
              </FieldLabel>
              <Input
                id="onboarding-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                disabled={pending}
              />
              <FieldDescription>
                {provider === "openai"
                  ? "Billed to your OpenAI API account, not your ChatGPT subscription. The Codex adapter also caches the key locally until sign-out."
                  : "Use a personal API key from your Devin account."}
              </FieldDescription>
            </Field>
          )}
          <Button
            type="button"
            disabled={
              pending || !isTauri() || (mode === "api_key" && !key.trim())
            }
            onClick={() => {
              const apiKey = key.trim();
              setKey("");
              void agent.signIn(
                provider,
                mode,
                mode === "api_key" ? apiKey : undefined,
              );
            }}
          >
            {pending ? (
              <>
                <Spinner data-icon="inline-start" />
                Connecting…
              </>
            ) : (
              `Connect ${providerLabels[provider]}`
            )}
          </Button>
          <FieldDescription>
            After connecting, choose from the models available to your account.
          </FieldDescription>
        </>
      )}
      {agent.status.message && <FieldError>{agent.status.message}</FieldError>}
    </FieldGroup>
  );
}
