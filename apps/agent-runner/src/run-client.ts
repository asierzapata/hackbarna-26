import { randomUUID } from "node:crypto";
import type { Mutation, NodeDraft, DataQuery } from "@kan/protocol";

export class HttpError extends Error {
  constructor(readonly status: number) { super(`http_${status}`); }
}

export function validateServerUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("invalid_server_url");
  return url.origin;
}

export async function requestJson<T>(url: string, credential: string, method = "GET", body?: unknown, retry = false, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000), redirect: "error" });
      if (!res.ok) throw new HttpError(res.status);
      return await res.json() as T;
    } catch (error) {
      if (!retry || attempt >= 1 || signal?.aborted || (error instanceof HttpError && error.status < 500)) throw error instanceof HttpError ? error : new Error("request_failed");
    }
  }
}

export class RunClient {
  readonly base: string;
  constructor(readonly serverUrl: string, readonly roomId: string, readonly runId: string, private readonly leaseToken: string, readonly signal?: AbortSignal) {
    this.base = `${validateServerUrl(serverUrl)}/rooms/${encodeURIComponent(roomId)}/runs/${encodeURIComponent(runId)}`;
  }
  request<T>(suffix: string, method = "GET", body?: unknown, retry = true) { return requestJson<T>(this.base + suffix, this.leaseToken, method, body, retry, this.signal); }
  canvas(input: { scope: "summary" | "selection" | "full"; shapeIds?: string[] }) {
    const query = new URLSearchParams({ scope: input.scope });
    for (const id of input.shapeIds ?? []) query.append("shapeIds", id);
    return this.request(`/canvas?${query}`);
  }
  mutate(operation: Mutation, requestId: string = randomUUID()) { return this.request("/mutate", "POST", { id: requestId, operations: [operation] }); }
  propose(draft: NodeDraft, requestId: string = randomUUID()) { return this.request("/suggestions", "POST", { id: requestId, draft }); }
  query(input: DataQuery) { return requestJson(`${this.serverUrl}/rooms/${this.roomId}/data/query`, this.leaseToken, "POST", input, true, this.signal); }
}
