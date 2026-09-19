/**
 * Devin agent runner, seen from the webview.
 *
 * The ACP client itself lives in Rust (`src-tauri/src/devin.rs`); this is the
 * thin side: three commands and one event stream. Nothing here knows about the
 * protocol beyond the shape of a `session/update`.
 *
 * Connecting is deliberately lazy — no `devin acp` process is spawned until
 * someone presses the button in the header.
 */
import * as React from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type DevinState =
  | "idle"
  | "connecting"
  | "needs_login"
  | "ready"
  | "unavailable";

export interface DevinStatus {
  state: DevinState;
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
export interface DevinToolCall {
  id: string;
  title?: string;
  kind?: string;
  /** ACP status: `pending` | `in_progress` | `completed` | `failed`. */
  status: string;
}

export interface PromptHandlers {
  /** A chunk of the agent's reply. Append, don't replace. */
  onText?: (text: string) => void;
  onTool?: (call: DevinToolCall) => void;
}

interface DevinApi {
  status: DevinStatus;
  /** Start the agent and report whether it needs a login. */
  connect: () => Promise<void>;
  /** Run the agent's browser auth flow, then open a session. */
  login: () => Promise<void>;
  /** Stop the agent. Credentials are untouched, so reconnecting is one click. */
  disconnect: () => Promise<void>;
  /** One prompt turn. Resolves when the turn ends. */
  prompt: (text: string, handlers: PromptHandlers) => Promise<void>;
  busy: boolean;
}

const DevinContext = React.createContext<DevinApi | null>(null);

export function DevinProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<DevinStatus>(() =>
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

    const updates = listen<SessionUpdate>("devin:update", ({ payload }) => {
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
          const call = payload as Omit<DevinToolCall, "id" | "status"> & {
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

    const closed = listen("devin:closed", () => {
      handlers.current = null;
      // Losing a live connection is worth reporting; following our own
      // disconnect (which already reset the status) is not.
      setStatus((prev) =>
        prev.state === "ready"
          ? { state: "idle", message: "Agent stopped" }
          : { state: "idle" }
      );
    });

    return () => {
      void updates.then((un) => un());
      void closed.then((un) => un());
    };
  }, []);

  const run = React.useCallback(
    async (command: "devin_connect" | "devin_login") => {
      setStatus((prev) => ({ ...prev, state: "connecting" }));
      try {
        setStatus(await invoke<DevinStatus>(command));
      } catch (error) {
        setStatus({ state: "unavailable", message: String(error) });
      }
    },
    []
  );

  const api: DevinApi = {
    status,
    busy,
    connect: () => run("devin_connect"),
    login: () => run("devin_login"),
    disconnect: async () => {
      setStatus({ state: "idle" });
      await invoke("devin_disconnect");
    },
    prompt: async (text, next) => {
      handlers.current = next;
      setBusy(true);
      try {
        await invoke<string>("devin_prompt", { text });
      } finally {
        handlers.current = null;
        setBusy(false);
      }
    },
  };

  return <DevinContext.Provider value={api}>{children}</DevinContext.Provider>;
}

export function useDevin() {
  const api = React.useContext(DevinContext);
  if (!api) throw new Error("useDevin must be used inside <DevinProvider>");
  return api;
}
