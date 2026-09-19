import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AgentRequestError, failure, normalizeFailure, type AgentFailure, type Mutation, type NodeDraft, type DataQuery } from "@kan/protocol";
import { recordRunnerDiagnostic } from "./diagnostics";

export class HttpError extends Error {
  readonly failure: AgentFailure;
  constructor(readonly status: number, response?: { error?: string; message?: string }) {
    super(`http_${status}`);
    const invalid = status === 400 && response?.error === "invalid_input";
    this.failure = failure(invalid ? "TOOL_VALIDATION_FAILED" : status === 403 ? "PERMISSION_DENIED" : "HTTP_FAILED", invalid ? "validation" : "http", status < 500 ? "not_applied" : "unknown", { httpStatus: status, retryable: status === 429 || status >= 500 });
    if (invalid && typeof response.message === "string") this.failure.issues = response.message.slice(0, 2048).split("; ").slice(0, 5).flatMap((issue) => {
      const match = /^([A-Za-z0-9_.]{0,160}): ([a-z_]{1,40})$/.exec(issue);
      return match ? [{ path: match[1], code: match[2] }] : [];
    });
  }
}

export function validateServerUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("invalid_server_url");
  return url.origin;
}

export async function requestJson<T>(url: string, credential: string, method = "GET", body?: unknown, retry = false, signal?: AbortSignal, trace: { runId?: string; phase?: string; requestId?: string } = {}): Promise<T> {
  const operationId = body && typeof body === "object" && "id" in body ? body.id : undefined;
  const safeRetry = method === "GET" || method === "HEAD" || (typeof operationId === "string" && /^[a-f0-9-]{36}$/i.test(operationId));
  const requestId = trace.requestId ?? (typeof operationId === "string" ? operationId : randomUUID());
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    let retryAfter = 0;
    recordRunnerDiagnostic({ ...trace, requestId, event: "http.started", attempt });
    try {
      signal?.throwIfAborted();
      const res = await fetch(url, { method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000), redirect: "error" });
      retryAfter = Math.min(2000, Math.max(0, Number(res.headers.get("retry-after")) * 1000 || 0));
      if (!res.ok) {
        let response: { error?: string; message?: string } | undefined;
        if (res.status === 400 && Number(res.headers.get("content-length")) <= 8192) {
          const reader = res.body?.getReader();
          const chunks: Uint8Array[] = []; let bytes = 0;
          try {
            if (reader) for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 8192) break; chunks.push(part.value); }
            if (bytes <= 8192) response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch { response = undefined; }
          finally { await reader?.cancel(); }
        } else await res.body?.cancel();
        throw new HttpError(res.status, response);
      }
      const result = await res.json() as T;
      recordRunnerDiagnostic({ ...trace, requestId, event: "http.completed", attempt, durationMs: performance.now() - started });
      return result;
    } catch (error) {
      const detail = error instanceof HttpError ? error.failure : signal?.aborted ? normalizeFailure(signal.reason, trace.phase ?? "http") : failure("TRANSPORT_FAILED", "http", method === "GET" ? "not_applied" : "unknown", { retryable: true });
      recordRunnerDiagnostic({ ...trace, requestId, event: "http.failed", attempt, durationMs: performance.now() - started, failure: detail });
      if (!retry || !safeRetry || attempt >= 1 || signal?.aborted || !detail.retryable) throw error instanceof HttpError ? error : new AgentRequestError(detail, { cause: error });
      recordRunnerDiagnostic({ ...trace, requestId, event: "http.retry_scheduled", attempt: attempt + 1 });
      await delay(Math.max(retryAfter, 150 + Math.floor(Math.random() * 100)), undefined, { signal });
    }
  }
}

export class RunClient {
  readonly base: string;
  constructor(readonly serverUrl: string, readonly roomId: string, readonly runId: string, private readonly leaseToken: string, readonly signal?: AbortSignal) {
    this.base = `${validateServerUrl(serverUrl)}/rooms/${encodeURIComponent(roomId)}/runs/${encodeURIComponent(runId)}`;
  }
  request<T>(suffix: string, method = "GET", body?: unknown, retry = true) { return requestJson<T>(this.base + suffix, this.leaseToken, method, body, retry, this.signal, { runId: this.runId, phase: suffix.replace(/^\//, "") || "stream" }); }
  canvas(input: { scope: "summary" | "selection" | "full"; shapeIds?: string[] }) {
    const query = new URLSearchParams({ scope: input.scope });
    for (const id of input.shapeIds ?? []) query.append("shapeIds", id);
    return this.request(`/canvas?${query}`);
  }
  mutate(operation: Mutation, requestId: string = randomUUID()) { return this.request("/mutate", "POST", { id: requestId, operations: [operation] }); }
  propose(draft: NodeDraft, requestId: string = randomUUID()) { return this.request("/suggestions", "POST", { id: requestId, draft }); }
  query(input: DataQuery) { return requestJson(`${this.serverUrl}/rooms/${this.roomId}/data/query`, this.leaseToken, "POST", input, false, this.signal, { runId: this.runId, phase: "query" }); }
}
