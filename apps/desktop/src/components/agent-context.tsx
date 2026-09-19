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
import { canvasToolDefinitions } from "@/lib/canvas-agent";
import { canvasThinkingTargets } from "@/lib/agent-thinking";
import { useQaSource } from "@/lib/qa-source";

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
  mode?: AuthMode | null;
  models?: { available: { id: string; label: string }[]; current: string | null };
}

export interface AgentPreferences {
  provider: Provider | null;
  mode: AuthMode | null;
  modelId: string | null;
  autoConnect: boolean;
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
  canvas?: { id: string; shapeIds?: string[]; execute: (name: string, input: unknown) => unknown };
}

interface CanvasToolRequest {
  requestId: string;
  turnId: string;
  canvasId: string;
  name: string;
  arguments: unknown;
  expiresAt: number;
}

interface AgentApi {
  status: AgentStatus;
  preferences: AgentPreferences | null;
  setModel: (modelId: string) => Promise<void>;
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
  thinkingShapeIds: string[];
  cancel: () => Promise<void>;
}

const AgentContext = React.createContext<AgentApi | null>(null);

export function AgentProvider({ children, canvasId }: { children: React.ReactNode; canvasId?: string }) {
  const [status, setStatus] = React.useState<AgentStatus>(() =>
    isTauri()
      ? { state: "idle" }
      : // The browser dev server has no Tauri IPC, so there is nothing to talk to.
        { state: "unavailable", message: "Only available in the desktop app" }
  );
  const [busy, setBusy] = React.useState(false);
  const [preferences, setPreferences] = React.useState<AgentPreferences | null>(null);
  const generation = React.useRef(0);
  const [thinkingShapeIds, setThinkingShapeIds] = React.useState<string[]>([]);
  useQaSource("agent", () => ({
    state: status.state, provider: status.provider, model: status.models?.current,
    message: status.message, busy, thinkingShapeIds,
  }));

  // One listener for the whole app; the in-flight prompt claims it.
  const handlers = React.useRef<PromptHandlers | null>(null);
  const turnId = React.useRef<string | null>(null);
  const listenersReady = React.useRef<Promise<unknown>>(Promise.resolve());

  React.useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;
    setThinkingShapeIds([]);
    setBusy(false);
    const request = ++generation.current;
    setStatus({ state: "connecting" });
    void invoke<AgentPreferences>("agent_preferences").then((saved) => {
      if (mounted) setPreferences(saved);
    }).catch(() => {});
    void invoke<AgentStatus>("agent_restore", { canvasId, tools: canvasToolDefinitions }).then((remote) => {
      if (mounted && request === generation.current) setStatus(remote);
    }).catch((error) => {
      if (mounted && request === generation.current) setStatus({ state: "idle", message: String(error) });
    });

    const updates = listen<{ turnId: string; update: SessionUpdate }>("agent:update", ({ payload: envelope }) => {
      const active = handlers.current;
      if (!active || envelope.turnId !== turnId.current) return;
      const payload = envelope.update;

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

    const canvas = listen<CanvasToolRequest>("canvas:tool", ({ payload }) => {
      const active = handlers.current?.canvas;
      if (!mounted || !active || payload.turnId !== turnId.current || payload.canvasId !== active.id) return;
      let result: unknown = null;
      let error: string | undefined;
      try {
        if (Date.now() >= payload.expiresAt) throw new Error("Canvas tool request expired");
        result = active.execute(payload.name, payload.arguments);
        const targets = canvasThinkingTargets(payload.name, payload.arguments, result);
        if (targets) setThinkingShapeIds(targets);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      void invoke("agent_canvas_result", { requestId: payload.requestId, turnId: payload.turnId, result, error }).catch(() => {});
    });

    const closed = listen("agent:closed", () => {
      handlers.current = null;
      turnId.current = null;
      setBusy(false);
      setThinkingShapeIds([]);
      // Losing a live connection is worth reporting; following our own
      // sign-out (which already reset the status) is not.
      setStatus((prev) =>
        prev.state === "ready"
          ? { state: "idle", message: "The agent stopped" }
          : { state: "idle" }
      );
    });

    listenersReady.current = Promise.all([updates, closed, canvas]);
    return () => {
      mounted = false;
      ++generation.current;
      const activeId = turnId.current;
      turnId.current = null;
      handlers.current = null;
      if (activeId) void invoke("agent_cancel", { turnId: activeId });
      void updates.then((un) => un());
      void closed.then((un) => un());
      void canvas.then((un) => un());
    };
  }, [canvasId]);

  const api: AgentApi = {
    status,
    busy,
    thinkingShapeIds,
    preferences,
    setModel: async (modelId) => {
      setBusy(true);
      try {
        setStatus(await invoke<AgentStatus>("agent_set_model", { modelId }));
        setPreferences(await invoke<AgentPreferences>("agent_preferences"));
      } catch (error) {
        const remote = await invoke<AgentStatus>("agent_status", { canvasId }).catch(() => status);
        setStatus({ ...remote, message: String(error) });
      } finally {
        setBusy(false);
      }
    },
    signIn: async (provider, mode, apiKey) => {
      const request = ++generation.current;
      setStatus({ state: "connecting", provider, providerLabel: providerLabels[provider] });
      try {
        const remote = await invoke<AgentStatus>("agent_sign_in", { provider, mode, apiKey, tools: canvasToolDefinitions, canvasId });
        if (request === generation.current) {
          setStatus(remote);
          setPreferences(await invoke<AgentPreferences>("agent_preferences"));
        }
      } catch (error) {
        if (request === generation.current) setStatus({ state: "unavailable", provider, message: String(error) });
      }
    },
    signOut: async () => {
      setThinkingShapeIds([]);
      handlers.current = null;
      ++generation.current;
      setStatus({ state: "connecting" });
      try {
        await invoke("agent_sign_out");
        setStatus({ state: "idle" });
        setPreferences(await invoke<AgentPreferences>("agent_preferences"));
      } catch (error) {
        setStatus({ state: "idle", message: String(error) });
      }
    },
    cancel: async () => {
      const activeId = turnId.current;
      handlers.current = null;
      setThinkingShapeIds([]);
      if (activeId) await invoke("agent_cancel", { turnId: activeId });
    },
    prompt: async (text, next) => {
      if (turnId.current) throw new Error("An agent turn is already running");
      const id = crypto.randomUUID();
      turnId.current = id;
      handlers.current = next;
      setThinkingShapeIds(next.canvas?.shapeIds ?? []);
      setBusy(true);
      try {
        await listenersReady.current;
        if (turnId.current !== id || !handlers.current) throw new Error("Agent turn cancelled");
        await invoke<string>("agent_prompt", { text, turnId: id, canvasId: next.canvas?.id });
      } finally {
        if (turnId.current === id) {
          turnId.current = null;
          handlers.current = null;
          setThinkingShapeIds([]);
          setBusy(false);
        }
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
