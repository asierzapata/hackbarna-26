import { AgentRequestError, failure, normalizeFailure, type AgentFailure, type DiagnosticEvent } from "@kan/protocol";

export interface ToolRequest {
  requestId: string;
  turnId: string;
  name: string;
  arguments: unknown;
  expiresAt: number;
}
export async function executeInstrumentedTool(request: ToolRequest, options: {
  active: () => boolean;
  execute: (name: string, input: unknown, assertActive: () => void) => unknown | Promise<unknown>;
  deliver: (value: { requestId: string; turnId: string; result: unknown; error?: AgentFailure }) => Promise<unknown>;
  record: (event: Omit<DiagnosticEvent, "id" | "at" | "source">) => void;
  onResult?: (result: unknown) => void;
}) {
  const started = performance.now();
  const record = (event: string, extra: Partial<DiagnosticEvent> = {}) => options.record({ event, turnId: request.turnId, requestId: request.requestId, tool: request.name, durationMs: performance.now() - started, ...extra });
  let beganExecution = false;
  const assertActive = () => {
    if (!options.active()) throw new AgentRequestError(failure("STALE_TURN", "execution", beganExecution ? "unknown" : "not_applied"));
    if (Date.now() >= request.expiresAt) throw new AgentRequestError(failure("TOOL_TIMEOUT", "execution", beganExecution ? "unknown" : "not_applied"));
  };
  let result: unknown = null;
  let error: AgentFailure | undefined;
  let executed = false;
  record("tool.execution_started", { deadline: request.expiresAt });
  try {
    assertActive();
    beganExecution = true;
    result = await options.execute(request.name, request.arguments, assertActive);
    executed = true;
    const bytes = new TextEncoder().encode(JSON.stringify(result ?? null)).byteLength;
    if (bytes > 1024 * 1024) throw new AgentRequestError(failure("RESULT_TOO_LARGE", "delivery", request.name === "getCanvas" ? "not_applied" : "applied"));
    record("tool.execution_finished", { bytes });
    if (options.active()) options.onResult?.(result);
  } catch (cause) {
    error = normalizeFailure(cause, "execution", executed ? "applied" : "unknown");
    result = null;
    record(error.code === "TOOL_VALIDATION_FAILED" ? "tool.validation_failed" : "tool.execution_failed", { failure: error });
  }
  try {
    await options.deliver({ requestId: request.requestId, turnId: request.turnId, result: result ?? null, error });
    record("tool.result_acknowledged");
  } catch (cause) {
    const delivery = failure("RESULT_DELIVERY_FAILED", "delivery", error?.outcome ?? (executed ? "applied" : "unknown"));
    record("tool.result_delivery_failed", { failure: delivery });
    throw new AgentRequestError(delivery, { cause });
  }
}
