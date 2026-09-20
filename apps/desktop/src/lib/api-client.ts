import type { AssistantEagerness, AssistantResult, Entry, Room, RoomEvent, User } from "@kan/protocol";
import { getInstallationProfile, type InstallationProfile } from "./installation-profile";

export interface ServerRoomSummary {
  id: string;
  localCanvasId: string;
  name: string;
  code: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  assistantPaused?: boolean;
  assistantEagerness?: AssistantEagerness;
  assistantThreshold?: number;
  assistantCooldownMs?: number;
  lastOpenedAt?: string | null;
}

export interface RoomDetailResponse {
  room: Room;
  members: User[];
}

export interface PublishResult {
  room: Room;
  created: boolean;
}

// The deployed room server. Point VITE_ROOM_SERVER_URL at
// http://localhost:8787 in .env.local to work against `npm run server`.
const DEFAULT_BACKEND_URL = "https://kan.asierzapata.com";

export function getBackendBaseUrl(): string {
  const envUrl = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ROOM_SERVER_URL;
  if (envUrl && envUrl.trim().length > 0) {
    return envUrl.trim().replace(/\/+$/, "");
  }
  return DEFAULT_BACKEND_URL;
}

/**
 * An unauthenticated liveness probe, used to decide whether creating an online
 * canvas is offerable at all. Deliberately not `listServerRooms`: that one
 * registers this installation with the backend, and a purely offline user who
 * only opened the create dialog has not asked for that.
 */
export async function checkServerReachable(timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(`${getBackendBaseUrl()}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

// Track registration state per backend origin
const registeredOrigins = new Set<string>();
let registrationPromise: Promise<void> | null = null;

export async function ensureBackendIdentity(): Promise<void> {
  const profile = await getInstallationProfile();
  if (!profile || !profile.name) {
    throw new Error("Cannot register with server: installation profile is incomplete");
  }

  const base = getBackendBaseUrl();
  const cacheKey = `${base}:${profile.installationId}`;

  if (registeredOrigins.has(cacheKey)) {
    return;
  }

  if (registrationPromise) {
    return registrationPromise;
  }

  registrationPromise = (async () => {
    try {
      const res = await fetch(`${base}/users/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: profile.installationId,
          secret: profile.secret,
          name: profile.name,
        }),
      });

      if (res.status === 200) {
        registeredOrigins.add(cacheKey);
        return;
      }

      if (res.status === 409) {
        throw new Error(
          "Installation credential conflict on server. Your local secret does not match the server's registered user."
        );
      }

      const text = await res.text();
      throw new Error(`Server registration failed with status ${res.status}: ${text}`);
    } finally {
      registrationPromise = null;
    }
  })();

  return registrationPromise;
}

function getAuthHeader(profile: InstallationProfile): string {
  return `Bearer ${profile.installationId}.${profile.secret}`;
}

async function authenticatedFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const profile = await getInstallationProfile();
  if (!profile) {
    throw new Error("No installation profile available for server authentication");
  }

  const base = getBackendBaseUrl();
  const headers = new Headers(options.headers);
  headers.set("Authorization", getAuthHeader(profile));

  return fetch(`${base}${path}`, {
    ...options,
    headers,
  });
}

export async function listServerRooms(): Promise<ServerRoomSummary[]> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch("/rooms");
  if (!res.ok) {
    throw new Error(`Failed to list rooms: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { rooms: ServerRoomSummary[] };
  return data.rooms;
}

export async function getServerRoom(roomId: string): Promise<RoomDetailResponse> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}`);
  if (!res.ok) {
    throw new Error(`Failed to get room ${roomId}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<RoomDetailResponse>;
}

export async function joinServerRoom(code: string): Promise<{ room: Room }> {
  await ensureBackendIdentity();
  const normalized = code.replace(/-/g, "").trim().toUpperCase();
  const res = await authenticatedFetch("/rooms/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: normalized }),
  });
  if (!res.ok) {
    const text = await res.text();
    let message = `Failed to join room: ${res.statusText}`;
    try {
      const json = JSON.parse(text) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      if (text) message = text;
    }
    throw new Error(message);
  }
  return res.json() as Promise<{ room: Room }>;
}

export async function publishServerRoom(payload: {
  localCanvasId: string;
  name: string;
  records?: unknown[];
  messages?: { id: string; text: string; at: string; anchors?: string[]; attachments?: string[]; source?: "typed" | "transcript"; replyToEntryId?: string }[];
  assetIds?: string[];
}): Promise<PublishResult> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch("/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to publish room: ${res.status} ${text}`);
  }
  return res.json() as Promise<PublishResult>;
}

/**
 * Drops this installation's membership. The room itself survives for everyone
 * else — there is no room deletion, by design — so this is "remove it from my
 * catalog", not "destroy the canvas".
 */
export async function leaveServerRoom(roomId: string): Promise<void> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}/leave`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to leave room: ${res.status}`);
}

export async function patchServerRoom(roomId: string, input: { name?: string; assistantPaused?: boolean; assistantEagerness?: AssistantEagerness; assistantThreshold?: number; assistantCooldownMs?: number }): Promise<RoomDetailResponse> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`Failed to patch room: ${res.status}`);
  return res.json() as Promise<RoomDetailResponse>;
}

export async function getServerRoomCanvas(roomId: string): Promise<{ records: unknown[] }> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}/canvas`);
  if (!res.ok) {
    throw new Error(`Failed to get canvas records for room ${roomId}: ${res.status}`);
  }
  return res.json() as Promise<{ records: unknown[] }>;
}

export async function uploadServerAsset(blob: Blob, contentType: string): Promise<{ id: string }> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch("/assets", {
    method: "POST",
    headers: {
      "content-type": contentType,
    },
    body: blob,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to upload asset: ${res.status} ${text}`);
  }
  return res.json() as Promise<{ id: string }>;
}

export async function fetchServerAsset(assetId: string): Promise<Blob> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/assets/${assetId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch asset ${assetId}: ${res.status}`);
  }
  return res.blob();
}

export async function startRoomCaptions(roomId: string, signal?: AbortSignal): Promise<void> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}/captions`, { method: "POST", signal });
  if (!res.ok) throw new Error("Live transcription is unavailable. You can still use the call and chat.");
}

export async function getRoomVideoToken(roomId: string, signal?: AbortSignal): Promise<{
  applicationId: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}/video-token`, { signal });
  if (!res.ok) {
    throw new Error(res.status === 503
      ? "Video calls are not configured on this server. You can still use the canvas."
      : res.status === 401 || res.status === 403
        ? "You do not have permission to join this call. Reopen the canvas and try again."
        : "The video service is unavailable. You can still use the canvas and retry the call.");
  }
  return res.json();
}

export async function createSocketTicket(
  roomId: string,
  channel: "sync" | "events"
): Promise<{ ticket: string; expiresAt: number }> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}/socket-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create ${channel} socket ticket: ${res.status}`);
  }
  return res.json() as Promise<{ ticket: string; expiresAt: number }>;
}

export function getRoomWebSocketUrl(
  roomId: string,
  channel: "sync" | "events",
  ticket: string,
  since?: number
): string {
  const url = new URL(getBackendBaseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/${channel}/${roomId}`;
  url.search = "";
  url.searchParams.set("ticket", ticket);
  if (channel === "events") url.searchParams.set("since", String(since ?? 0));
  return url.toString();
}

export async function postServerMessage(
  roomId: string,
  input: { id: string; text: string; anchors?: string[]; attachments?: string[]; source?: "typed" | "transcript"; replyToEntryId?: string }
): Promise<void> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to post message: ${res.status}`);
}

export async function resolveServerSuggestion(
  roomId: string,
  entryId: string,
  accepted: boolean
): Promise<void> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}/suggestions/${entryId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resolution: accepted ? "accepted" : "dismissed" }),
  });
  if (!res.ok) throw new Error(`Failed to resolve suggestion: ${res.status}`);
}

/**
 * The run endpoints are the one place a failure has nowhere else to surface:
 * the lease execution catches it, marks the run failed, and the thread is left
 * showing an empty agent entry. A bare `409` cannot tell you whether the room
 * drifted under the turn or the evidence was rejected, and the server already
 * says which — `{error, message}` — so carry its words instead of the number
 * alone.
 */
async function runError(action: string, res: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    detail = [body?.error, body?.message]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(": ");
  } catch {
    // A non-JSON body (a proxy's HTML error page, say) still has a status.
  }
  return new Error(`${action} (${res.status})${detail ? `: ${detail}` : ""}`);
}

export async function claimServerTrigger(roomId: string, triggerId: string, sessionId: string, manual = true): Promise<{ lease: import("@kan/protocol").Lease }> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}/triggers/${triggerId}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, manual }) });
  if (!res.ok) throw await runError("Failed to claim trigger", res);
  return res.json() as Promise<{ lease: import("@kan/protocol").Lease }>;
}

export async function retryServerTrigger(roomId: string, triggerId: string, requestId: string): Promise<{ trigger: import("@kan/protocol").Trigger }> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}/triggers/${triggerId}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: requestId }) });
  if (!res.ok) throw await runError("Failed to retry trigger", res);
  return res.json() as Promise<{ trigger: import("@kan/protocol").Trigger }>;
}

export async function cancelServerTrigger(roomId: string, triggerId: string): Promise<{ trigger: import("@kan/protocol").Trigger }> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}/triggers/${triggerId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!res.ok) throw await runError("Failed to cancel trigger", res);
  return res.json() as Promise<{ trigger: import("@kan/protocol").Trigger }>;
}

export async function resolveServerOffer(roomId: string, entryId: string, accepted: boolean): Promise<{ entry: Entry; trigger?: import("@kan/protocol").Trigger }> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}/offers/${entryId}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution: accepted ? "accepted" : "dismissed" }) });
  if (!res.ok) throw new Error(`Failed to resolve offer: ${res.status}`);
  return res.json() as Promise<{ entry: Entry; trigger?: import("@kan/protocol").Trigger }>;
}

export async function heartbeatServerRun(roomId: string, runId: string, leaseToken: string): Promise<{ expiresAt: number }> {
  const res = await fetch(`${getBackendBaseUrl()}/rooms/${roomId}/runs/${runId}/heartbeat`, { method: "POST", headers: { Authorization: `Bearer ${leaseToken}` } });
  if (!res.ok) throw await runError("Run lease expired", res);
  return res.json() as Promise<{ expiresAt: number }>;
}

export async function patchServerRun(roomId: string, runId: string, leaseToken: string, input: { id: string; status: "failed" | "cancelled" }): Promise<{ entry: Entry }> {
  const res = await fetch(`${getBackendBaseUrl()}/rooms/${roomId}/runs/${runId}`, { method: "PATCH", headers: { "content-type": "application/json", Authorization: `Bearer ${leaseToken}` }, body: JSON.stringify(input) });
  if (!res.ok) throw await runError("Failed to mark run", res);
  return res.json() as Promise<{ entry: Entry }>;
}

export async function getServerRunContext(roomId: string, runId: string, leaseToken: string): Promise<{ trigger: import("@kan/protocol").Trigger; causeEntries: Entry[]; recentEntries: Entry[]; canvas: unknown; revision: string }> {
  const res = await fetch(`${getBackendBaseUrl()}/rooms/${roomId}/runs/${runId}/context`, { headers: { Authorization: `Bearer ${leaseToken}` } });
  if (!res.ok) throw await runError("Failed to fetch run context", res);
  return res.json() as Promise<{ trigger: import("@kan/protocol").Trigger; causeEntries: Entry[]; recentEntries: Entry[]; canvas: unknown; revision: string }>;
}

export async function completeServerRun(roomId: string, runId: string, input: { id: string; revision: string; result: AssistantResult }, leaseToken?: string): Promise<{ entry: Entry; outcomeEntry?: Entry }> {
  await ensureBackendIdentity();
  const res = await fetch(`${getBackendBaseUrl()}/rooms/${roomId}/runs/${runId}/complete`, { method: "POST", headers: { "content-type": "application/json", ...(leaseToken ? { Authorization: `Bearer ${leaseToken}` } : {}) }, body: JSON.stringify(input) });
  if (!res.ok) throw await runError("Failed to complete run", res);
  return res.json() as Promise<{ entry: Entry; outcomeEntry?: Entry }>;
}

export async function getServerEvents(
  roomId: string,
  since: number
): Promise<{ events: RoomEvent[]; nextCursor: number; hasMore: boolean; currentCursor: number }> {
  await ensureBackendIdentity();
  const res = await authenticatedFetch(`/rooms/${roomId}/events?since=${since}&limit=100`);
  if (!res.ok) throw new Error(`Failed to replay room events: ${res.status}`);
  return res.json() as Promise<{
    events: RoomEvent[];
    nextCursor: number;
    hasMore: boolean;
    currentCursor: number;
  }>;
}
