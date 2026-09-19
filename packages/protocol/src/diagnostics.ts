export const failureMessages = {
  TOOL_VALIDATION_FAILED: "Tool arguments did not match the schema. Correct the listed fields before retrying.",
  TOOL_EXECUTION_FAILED: "The canvas tool could not finish. Inspect the canvas before retrying.",
  TOOL_NOT_FOUND: "Unknown canvas tool.",
  TARGET_NOT_FOUND: "The target shape no longer exists. Refresh getCanvas before retrying.",
  PERMISSION_DENIED: "The requested tool is not permitted for this turn.",
  STALE_TURN: "The canvas or agent turn is no longer active.",
  TOOL_TIMEOUT: "The tool deadline expired. Its outcome may be unknown; do not replay a mutation blindly.",
  RESULT_TOO_LARGE: "The tool result exceeded the size limit. Request a smaller canvas summary.",
  RESULT_DELIVERY_FAILED: "The tool ran, but its result could not be acknowledged.",
  OPERATION_CONFLICT: "This operation ID was already used with different arguments.",
  TOO_MANY_REQUESTS: "The canvas tool queue is full.",
  AGENT_TIMEOUT: "The agent did not complete before its deadline.",
  AGENT_EXITED: "The agent process exited before completing the request.",
  AGENT_RPC_FAILED: "The agent rejected the protocol request.",
  PROTOCOL_INVALID: "The agent sent an invalid protocol message.",
  TURN_INCOMPLETE: "The agent stopped without completing the turn.",
  STRUCTURED_OUTPUT_INVALID: "The agent returned unusable structured output.",
  CANCELLED: "The turn was cancelled.",
  HTTP_FAILED: "The room server rejected the request.",
  TRANSPORT_FAILED: "The request could not reach its destination.",
  LEASE_EXPIRED: "The execution lease expired.",
  DIAGNOSTICS_UNAVAILABLE: "Diagnostic persistence is unavailable; recent events remain in memory.",
} as const;

export type FailureCode = keyof typeof failureMessages;
export type Outcome = "not_applied" | "applied" | "unknown";
export interface AgentFailure {
  code: FailureCode;
  phase: string;
  message: string;
  retryable: boolean;
  outcome: Outcome;
  issues?: { path: string; code: string }[];
  httpStatus?: number;
  rpcCode?: number;
}
export interface DiagnosticEvent {
  id: string;
  at: number;
  event: string;
  source: "frontend" | "native" | "runner";
  turnId?: string;
  runId?: string;
  connectionId?: string;
  sessionId?: string;
  requestId?: string;
  toolCallId?: string;
  tool?: string;
  provider?: string;
  model?: string;
  phase?: string;
  durationMs?: number;
  bytes?: number;
  attempt?: number;
  deadline?: number;
  exitCode?: number;
  failure?: AgentFailure;
}
export class AgentRequestError extends Error {
  readonly cause?: unknown;
  constructor(readonly failure: AgentFailure, options?: { cause?: unknown }) {
    super(failure.message);
    this.cause = options?.cause;
    this.name = failure.code === "CANCELLED" ? "AbortError" : "AgentRequestError";
  }
}
export function failure(code: FailureCode, phase: string, outcome: Outcome = "unknown", extra: Partial<AgentFailure> = {}): AgentFailure {
  return { code, phase, message: failureMessages[code], retryable: false, outcome, ...extra };
}
export function normalizeFailure(error: unknown, phase: string, outcome: Outcome = "unknown"): AgentFailure {
  if (error instanceof AgentRequestError) return error.failure;
  const item = error && typeof error === "object" ? error as Record<string, unknown> : {};
  if (item.failure && typeof item.failure === "object" && "code" in item.failure) return normalizeFailure(item.failure, phase, outcome);
  if (typeof item.code === "string" && Object.prototype.hasOwnProperty.call(failureMessages, item.code)) {
    return failure(item.code as FailureCode, typeof item.phase === "string" ? item.phase : phase,
      ["not_applied", "applied", "unknown"].includes(String(item.outcome)) ? item.outcome as Outcome : outcome,
      { retryable: item.retryable === true, ...(Array.isArray(item.issues) ? { issues: item.issues as AgentFailure["issues"] } : {}), ...(typeof item.httpStatus === "number" ? { httpStatus: item.httpStatus } : {}), ...(typeof item.rpcCode === "number" ? { rpcCode: item.rpcCode } : {}) });
  }
  if (Array.isArray(item.issues)) return failure("TOOL_VALIDATION_FAILED", "validation", "not_applied", {
    issues: item.issues.slice(0, 12).map((issue: { path?: unknown[]; code?: string }) => ({
      path: (issue.path ?? []).map((part) => typeof part === "number" ? part : /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(String(part)) ? part : "[field]").join(".").slice(0, 160),
      code: /^[a-z_]{1,40}$/.test(issue.code ?? "") ? issue.code! : "invalid",
    })),
  });
  const text = error instanceof Error ? error.message : String(error);
  if (item.name === "AbortError" || /cancelled/i.test(text)) return failure("CANCELLED", phase, outcome);
  if (item.name === "TimeoutError" || /timed out/i.test(text)) return failure(phase === "execution" ? "TOOL_TIMEOUT" : "AGENT_TIMEOUT", phase, outcome);
  if (/exited|agent stopped|disconnected/i.test(text)) return failure("AGENT_EXITED", phase, outcome);
  if (/Shape not found|not on the current page|Shape not found on current page/i.test(text)) return failure("TARGET_NOT_FOUND", phase, "not_applied");
  if (/expired|no longer active|Stale canvas/i.test(text)) return failure("STALE_TURN", phase, outcome);
  return failure(phase === "execution" ? "TOOL_EXECUTION_FAILED" : phase === "parse" ? "STRUCTURED_OUTPUT_INVALID" : "AGENT_RPC_FAILED", phase, outcome);
}

const tools = new Set(["addNode", "addMermaidDiagram", "updateNode", "removeNodes", "connectNodes", "arrange", "focusNodes", "groupNodes", "getCanvas", "queryData", "proposeNode"]);
const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) && !/^(sk-|gh[pousr]_|github_pat_|eyJ)/.test(value) ? value : undefined;
export function sanitizeDiagnostic(input: DiagnosticEvent): DiagnosticEvent {
  const output: DiagnosticEvent = { id: identifier(input.id) ?? crypto.randomUUID(), at: Number.isFinite(input.at) ? input.at : Date.now(), event: /^[a-z][a-z_.]{0,63}$/.test(input.event) ? input.event : "diagnostic.invalid", source: ["frontend", "native", "runner"].includes(input.source) ? input.source : "frontend" };
  for (const key of ["turnId", "runId", "connectionId", "sessionId", "requestId", "toolCallId", "provider", "model", "phase"] as const) {
    const value = identifier(input[key]);
    if (value) output[key] = value;
  }
  if (input.tool) output.tool = tools.has(input.tool) ? input.tool : "unknown";
  for (const key of ["durationMs", "bytes", "attempt", "deadline", "exitCode"] as const) if (typeof input[key] === "number" && Number.isFinite(input[key])) output[key] = input[key];
  if (input.failure) {
    const normalized = normalizeFailure(input.failure, output.phase ?? "unknown");
    output.failure = { ...normalized, phase: identifier(normalized.phase) ?? "unknown" };
    if (normalized.issues) output.failure.issues = normalized.issues.slice(0, 12).map((issue) => ({ path: /^[A-Za-z0-9_.\[\]-]{0,160}$/.test(issue.path) ? issue.path : "[field]", code: /^[a-z_]{1,40}$/.test(issue.code) ? issue.code : "invalid" }));
  }
  return output;
}
export function createDiagnosticBuffer(limit = 500) {
  const events: DiagnosticEvent[] = [];
  return {
    add(input: DiagnosticEvent) {
      const event = sanitizeDiagnostic(input);
      if (events.some((existing) => existing.id === event.id)) return;
      events.push(event);
      if (events.length > limit) events.splice(0, events.length - limit);
    },
    snapshot: (turnId?: string) => events.filter((event) => !turnId || event.turnId === turnId || event.runId === turnId).map((event) => structuredClone(event)),
  };
}
