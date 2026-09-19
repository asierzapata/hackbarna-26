import type { Room, RoomEvent, User } from "@kan/protocol";
import { getInstallationProfile, type InstallationProfile } from "./installation-profile";

export interface ServerRoomSummary {
  id: string;
  localCanvasId: string;
  name: string;
  code: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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

const DEFAULT_BACKEND_URL = "http://localhost:8787";

export function getBackendBaseUrl(): string {
  // Allow overriding via environment variable
  const envUrl = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ROOM_SERVER_URL;
  if (envUrl && envUrl.trim().length > 0) {
    return envUrl.trim().replace(/\/+$/, "");
  }
  return DEFAULT_BACKEND_URL;
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
  messages?: { id: string; text: string; at: string; anchors?: string[]; attachments?: string[] }[];
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
  input: { id: string; text: string; anchors?: string[]; attachments?: string[] }
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
