import { AssistantResultSchema, type AssistantResult } from "@kan/protocol";

export interface AssistantPreferences {
  scope: "own" | "room" | "manual";
  background: boolean;
}

export interface AssistantExecutor {
  ready: boolean;
  agentId: string;
  run(mode: "act" | "context" | "propose", context: unknown, signal: AbortSignal): Promise<AssistantResult>;
}

let activeExecutor = false;

export function parseAssistantResult(raw: unknown): AssistantResult {
  return AssistantResultSchema.parse(raw);
}

export interface LeaseExecutionArgs {
  triggerId: string;
  attempt: number;
  runId: string;
  leaseToken: string;
  expiresAt: number;
  mode: "act" | "context" | "propose";
  getContext: (signal: AbortSignal) => Promise<{ revision: string; value: unknown }>;
  run: (mode: "act" | "context" | "propose", context: unknown, signal: AbortSignal) => Promise<AssistantResult>;
  heartbeat: () => Promise<{ expiresAt: number }>;
  complete: (input: { id: string; revision: string; result: AssistantResult }, signal: AbortSignal) => Promise<unknown>;
  fail: (status: "failed" | "cancelled") => Promise<void>;
}

export interface LeaseExecution {
  triggerId: string;
  attempt: number;
  runId: string;
  mode: "act" | "context" | "propose";
  completionId: string;
  controller: AbortController;
  promise: Promise<void>;
}

export function startLeaseExecution(args: LeaseExecutionArgs): LeaseExecution {
  const controller = new AbortController();
  const completionId = crypto.randomUUID();
  let deadline = args.expiresAt;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    const wait = Math.max(0, deadline - Date.now());
    deadlineTimer = setTimeout(() => controller.abort(), wait);
  };
  const promise = (async () => {
    try {
      const beat = async () => {
        if (controller.signal.aborted) return;
        try { deadline = (await args.heartbeat()).expiresAt; schedule(); } catch { controller.abort(); }
        heartbeatTimer = setTimeout(beat, 10_000);
      };
      schedule();
      heartbeatTimer = setTimeout(beat, 10_000);
      const context = await args.getContext(controller.signal);
      if (controller.signal.aborted) throw new DOMException("assistant turn cancelled", "AbortError");
      const result = await args.run(args.mode, context.value, controller.signal);
      if (controller.signal.aborted) throw new DOMException("assistant turn cancelled", "AbortError");
      await args.complete({ id: completionId, revision: context.revision, result }, controller.signal);
    } catch (error) {
      await args.fail(error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed");
    } finally {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  })();
  return { triggerId: args.triggerId, attempt: args.attempt, runId: args.runId, mode: args.mode, completionId, controller, promise };
}

export async function runAssistantTurn(executor: AssistantExecutor, mode: "act" | "context" | "propose", context: unknown, signal: AbortSignal) {
  if (!executor.ready) throw new Error("agent is not ready");
  if (activeExecutor) throw new Error("another assistant turn is already running");
  activeExecutor = true;
  try {
    if (signal.aborted) throw new DOMException("assistant turn cancelled", "AbortError");
    const result = parseAssistantResult(await executor.run(mode, context, signal));
    if (signal.aborted) throw new DOMException("assistant turn cancelled", "AbortError");
    if ((mode === "context" || mode === "propose") && result.kind === "act") throw new Error("contextual assistant turns cannot act");
    return result;
  } finally {
    activeExecutor = false;
  }
}
