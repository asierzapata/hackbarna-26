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

/**
 * Pulls the result object out of one structured agent turn.
 *
 * The policy prompt asks for a bare JSON object and nothing else, and the
 * adapters mostly comply — but "mostly" is not a contract. A stray ```json
 * fence or a polite sentence before the brace used to fail the whole run at
 * `JSON.parse`, losing a lease and a real agent turn to a formatting habit.
 *
 * So: scan for the first balanced top-level object and parse that. Braces
 * inside strings do not count, which is why this is a scanner and not a
 * regex. Anything outside the object is ignored, and a turn that contains no
 * object at all still fails — silently accepting prose would let an agent
 * skip the contract entirely.
 */
export function extractStructuredJson(raw: string): unknown {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") { if (depth === 0) start = i; depth += 1; continue; }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error("agent returned no JSON object");
}

/** `extractStructuredJson` plus the schema, which is always how it is used. */
export function parseStructuredOutput(raw: string): AssistantResult {
  return parseAssistantResult(extractStructuredJson(raw));
}

/**
 * Where a lease execution was when it gave up.
 *
 * "failed" on its own is the least useful thing a run can say: the thread ends
 * up showing an empty agent entry and nothing anywhere records whether the
 * context fetch 409'd, the agent returned prose instead of JSON, or the
 * completion was rejected. The phase plus the original error is the difference
 * between a bug report and a shrug.
 */
export type LeasePhase = "context" | "agent" | "complete" | "heartbeat";

export interface LeaseFailure {
  phase: LeasePhase;
  error: unknown;
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
  /** Beat interval; only a test has any reason to move it. */
  heartbeatMs?: number;
  complete: (input: { id: string; revision: string; result: AssistantResult }, signal: AbortSignal) => Promise<unknown>;
  fail: (status: "failed" | "cancelled", failure: LeaseFailure) => Promise<void>;
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
  // A lost heartbeat aborts the turn, so without this the cause would be
  // reported as a plain cancellation — indistinguishable from the user
  // pressing stop.
  let lost: LeaseFailure | undefined;
  let phase: LeasePhase = "context";
  const promise = (async () => {
    try {
      const beat = async () => {
        if (controller.signal.aborted) return;
        try { deadline = (await args.heartbeat()).expiresAt; schedule(); }
        catch (error) { lost = { phase: "heartbeat", error }; controller.abort(); }
        heartbeatTimer = setTimeout(beat, args.heartbeatMs ?? 10_000);
      };
      schedule();
      heartbeatTimer = setTimeout(beat, args.heartbeatMs ?? 10_000);
      const context = await args.getContext(controller.signal);
      if (controller.signal.aborted) throw new DOMException("assistant turn cancelled", "AbortError");
      phase = "agent";
      const result = await args.run(args.mode, context.value, controller.signal);
      if (controller.signal.aborted) throw new DOMException("assistant turn cancelled", "AbortError");
      phase = "complete";
      await args.complete({ id: completionId, revision: context.revision, result }, controller.signal);
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      await args.fail(cancelled && !lost ? "cancelled" : "failed", lost ?? { phase, error });
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
