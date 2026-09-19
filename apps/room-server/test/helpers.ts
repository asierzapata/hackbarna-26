import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { openDb } from "../src/db";
import { createRoomServer, type RoomServer } from "../src/server";
import type { Classifier } from "../src/classifier";
import type { VideoProvider } from "../src/video";
import type { ClassificationState, Decision } from "../src/decision-policy";

export class ManualClock {
  t = 1_000_000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export class StubClassifier implements Classifier {
  calls: ClassificationState[] = [];
  next: Decision | ((s: ClassificationState) => Decision | Promise<Decision>) = {
    addressedProbability: 0,
    worthCapturingProbability: 0,
    intent: "none",
    intentProbability: 1,
    relatedShapeId: null,
    needsExternalDataProbability: 0,
    captureScore: 0,
  };
  async decide(state: ClassificationState): Promise<Decision> {
    this.calls.push(state);
    if (typeof this.next === "function") return this.next(state);
    return this.next;
  }
}

export function stubVideo(): VideoProvider & { sessions: number; tokens: { sessionId: string; data: string }[] } {
  const state = { sessions: 0, tokens: [] as { sessionId: string; data: string }[] };
  return {
    applicationId: "test-application",
    sessions: 0,
    tokens: state.tokens,
    async createSession() {
      state.sessions += 1;
      this.sessions = state.sessions;
      return { sessionId: `vsession-${state.sessions}` };
    },
    generateClientToken(sessionId: string, opts: { data: string }) {
      state.tokens.push({ sessionId, data: opts.data });
      return `token:${sessionId}:${opts.data}`;
    },
  };
}

export interface TestContext {
  server: RoomServer;
  base: string;
  dir: string;
  clock: ManualClock;
  classifier: StubClassifier;
  video: ReturnType<typeof stubVideo>;
  cleanup(): Promise<void>;
}

export async function setup(overrides: {
  timings?: Partial<import("../src/engine").Timings>;
  classifier?: Classifier | null;
  video?: VideoProvider | null;
  memoryDb?: boolean;
  maxSendBuffer?: number;
} = {}): Promise<TestContext> {
  const dir = mkdtempSync(join(tmpdir(), "kan-test-"));
  const clock = new ManualClock();
  const classifier = new StubClassifier();
  const video = stubVideo();
  const db = openDb(overrides.memoryDb === false ? join(dir, "kan.sqlite") : join(dir, "kan.sqlite"));
  const server = createRoomServer({
    db,
    now: clock.now,
    maxSendBuffer: overrides.maxSendBuffer,
    classifier: overrides.classifier === undefined ? classifier : overrides.classifier,
    video: overrides.video === undefined ? video : overrides.video,
    timings: { tickMs: 0, offerMs: 5000, leaseMs: 30_000, presenceTtlMs: 20_000, debounceMs: 2000, cooldownMs: 30_000, ticketTtlMs: 30_000, roomIdleMs: 60_000, ...overrides.timings },
  });
  await new Promise<void>((res) => server.server.listen(0, "127.0.0.1", res));
  const base = `http://127.0.0.1:${server.port()}`;
  let cleaned = false;
  return {
    server,
    base,
    dir,
    clock,
    classifier,
    video,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await server.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestUser {
  id: string;
  secret: string;
  name: string;
  auth: string;
}

export async function registerUser(base: string, name = "user"): Promise<TestUser> {
  const id = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const res = await fetch(`${base}/users/register`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ userId: id, secret, name }),
  });
  if (!res.ok) throw new Error(`register failed ${res.status} ${await res.text()}`);
  return { id, secret, name, auth: `Bearer ${id}.${secret}` };
}

export function authed(user: TestUser, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), authorization: user.auth } };
}

export async function api(user: TestUser | null, base: string, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    connection: "close",
    ...(init.headers as any),
  };
  if (user) headers.authorization = user.auth;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

export async function createRoom(user: TestUser, base: string, extra: Record<string, unknown> = {}) {
  const res = await api(user, base, "/rooms", {
    method: "POST",
    body: JSON.stringify({ localCanvasId: randomUUID(), name: "Test room", ...extra }),
  });
  if (res.status !== 200) throw new Error(`createRoom failed ${JSON.stringify(res.body)}`);
  return res.body.room;
}

export async function ticket(user: TestUser, base: string, roomId: string, channel: "sync" | "events") {
  const res = await api(user, base, `/rooms/${roomId}/socket-ticket`, {
    method: "POST",
    body: JSON.stringify({ channel }),
  });
  if (res.status !== 200) throw new Error(`ticket failed ${JSON.stringify(res.body)}`);
  return res.body.ticket as string;
}

export class EventsClient {
  ws: WebSocket;
  messages: any[] = [];
  ready: Promise<any>;
  sessionId = "";
  constructor(public port: number, roomId: string, ticketStr: string, since = 0) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/events/${roomId}?ticket=${ticketStr}&since=${since}`);
    this.ready = new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("no ready message")), 5000);
      this.ws.on("message", (d) => {
        const msg = JSON.parse(String(d));
        this.messages.push(msg);
        if (msg.type === "ready") {
          this.sessionId = msg.sessionId;
          clearTimeout(to);
          resolve(msg);
        }
        if (msg.type === "error") {
          clearTimeout(to);
          reject(new Error(msg.error));
        }
      });
      this.ws.on("error", reject);
    });
  }
  send(obj: unknown) {
    this.ws.send(JSON.stringify(obj));
  }
  executorReady(agentId = "stub-agent") {
    this.send({ type: "executor.ready", ready: true, agentId, scope: "room", background: true });
  }
  async waitFor(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const found = this.messages.find(pred);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
      const check = (d: WebSocket.RawData) => {
        const msg = JSON.parse(String(d));
        if (pred(msg)) {
          clearTimeout(to);
          this.ws.off("message", check);
          resolve(msg);
        }
      };
      this.ws.on("message", check);
    });
  }
  close() {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
