/**
 * The agent runner, seen from the webview.
 *
 * The ACP client itself lives in Rust (`src-tauri/src/agent.rs`); this is the
 * thin side: three commands and one event stream. Nothing here knows about the
 * protocol beyond the shape of a `session/update`, or about the difference
 * between the providers beyond their names.
 *
 * Connecting is deliberately lazy — no agent process is spawned until someone
 * signs in from the header. Exactly one provider is connected at a time.
 */
import * as React from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Providers, keyed the way the Rust side deserializes them. */
export type Provider = "devin" | "openai";

/** Which credentials to sign in with. */
export type AuthMode = "subscription" | "api_key";

export const providerLabels: Record<Provider, string> = {
  devin: "Devin",
  openai: "OpenAI",
};

export type AgentState = "idle" | "connecting" | "ready" | "unavailable";

export interface AgentStatus {
  state: AgentState;
  provider?: Provider | null;
  providerLabel?: string | null;
  agent?: string | null;
  message?: string | null;
}

/** The subset of ACP session updates the thread renders. */
type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content?: { text?: string } }
  | { sessionUpdate: "agent_thought_chunk"; content?: { text?: string } }
  | { sessionUpdate: "tool_call"; toolCallId: string; title?: string; kind?: string; status?: string }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; title?: string; kind?: string; status?: string }
  | { sessionUpdate: string };

/** A tool call as the thread wants it: `kind` and `title` may arrive apart. */
export interface AgentToolCall {
  id: string;
  title?: string;
  kind?: string;
  /** ACP status: `pending` | `in_progress` | `completed` | `failed`. */
  status: string;
}

export interface PromptHandlers {
  /** A chunk of the agent's reply. Append, don't replace. */
  onText?: (text: string) => void;
  onTool?: (call: AgentToolCall) => void;
}

interface AgentApi {
  status: AgentStatus;
  /**
   * Start a provider and open a session with the chosen credentials. The key is
   * only read for `api_key` mode and is never persisted — on either side.
   */
  signIn: (
    provider: Provider,
    mode: AuthMode,
    apiKey?: string
  ) => Promise<void>;
  /** Stop the agent. Stored subscription credentials are untouched. */
  signOut: () => Promise<void>;
  /** One prompt turn. Resolves when the turn ends. */
  prompt: (text: string, handlers: PromptHandlers) => Promise<void>;
  busy: boolean;
}

const AgentContext = React.createContext<AgentApi | null>(null);

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<AgentStatus>(() =>
    isTauri()
      ? { state: "idle" }
      : // The browser dev server has no Tauri IPC, so there is nothing to talk to.
        { state: "unavailable", message: "Only available in the desktop app" }
  );
  const [busy, setBusy] = React.useState(false);

  // One listener for the whole app; the in-flight prompt claims it.
  const handlers = React.useRef<PromptHandlers | null>(null);

  React.useEffect(() => {
    if (!isTauri()) return;

    const updates = listen<SessionUpdate>("agent:update", ({ payload }) => {
      const active = handlers.current;
      if (!active) return;

      switch (payload.sessionUpdate) {
        case "agent_message_chunk": {
          const text = (payload as { content?: { text?: string } }).content?.text;
          if (text) active.onText?.(text);
          break;
        }
        case "tool_call":
        case "tool_call_update": {
          const call = payload as Omit<AgentToolCall, "id" | "status"> & {
            toolCallId: string;
            status?: string;
          };
          active.onTool?.({
            id: call.toolCallId,
            title: call.title,
            kind: call.kind,
            status: call.status ?? "pending",
          });
          break;
        }
      }
    });

    const closed = listen("agent:closed", () => {
      handlers.current = null;
      // Losing a live connection is worth reporting; following our own
      // sign-out (which already reset the status) is not.
      setStatus((prev) =>
        prev.state === "ready"
          ? { state: "idle", message: "The agent stopped" }
          : { state: "idle" }
      );
    });

    return () => {
      void updates.then((un) => un());
      void closed.then((un) => un());
    };
  }, []);

  const api: AgentApi = {
    status,
    busy,
    signIn: async (provider, mode, apiKey) => {
      setStatus({ state: "connecting", provider, providerLabel: providerLabels[provider] });
      try {
        setStatus(
          await invoke<AgentStatus>("agent_sign_in", { provider, mode, apiKey })
        );
      } catch (error) {
        setStatus({ state: "unavailable", provider, message: String(error) });
      }
    },
    signOut: async () => {
      setStatus({ state: "idle" });
      await invoke("agent_sign_out");
    },
    prompt: async (text, next) => {
      handlers.current = next;
      setBusy(true);
      try {
        await invoke<string>("agent_prompt", { text });
      } finally {
        handlers.current = null;
        setBusy(false);
      }
    },
  };

  return <AgentContext.Provider value={api}>{children}</AgentContext.Provider>;
}

export function useAgent() {
  const api = React.useContext(AgentContext);
  if (!api) throw new Error("useAgent must be used inside <AgentProvider>");
  return api;
}
