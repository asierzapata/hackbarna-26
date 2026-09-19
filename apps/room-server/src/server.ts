import { createAdaptorServer } from "@hono/node-server";
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { EventsClientMessage, type ServerMessage } from "@kan/protocol";
import type { DatabaseSync } from "node:sqlite";
import { Engine, type EngineOptions } from "./engine";
import { createApp } from "./http";
import type { Classifier } from "./classifier";
import type { VideoProvider } from "./video";

export interface RoomServerOptions extends Omit<EngineOptions, "db"> {
  db: DatabaseSync;
  allowedOrigins?: string[];
  maxSyncPayload?: number;
  maxEventsPayload?: number;
}

export interface RoomServer {
  engine: Engine;
  server: Server;
  port(): number;
  close(): Promise<void>;
}

export const DEFAULT_ORIGINS = ["http://localhost:1420", "tauri://localhost", "http://tauri.localhost"];

export function createRoomServer(opts: RoomServerOptions): RoomServer {
  const engine = new Engine(opts);
  const allowedOrigins = opts.allowedOrigins ?? DEFAULT_ORIGINS;
  const app = createApp(engine, allowedOrigins);
  const server = createAdaptorServer({ fetch: app.fetch }) as unknown as Server;
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.setTimeout(15_000);

  const syncWss = new WebSocketServer({ noServer: true, maxPayload: opts.maxSyncPayload ?? 4 * 1024 * 1024 });
  const eventsWss = new WebSocketServer({ noServer: true, maxPayload: opts.maxEventsPayload ?? 64 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const reject = (msg: string) => {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.includes(origin)) return reject("origin");
      const syncMatch = /^\/sync\/([0-9a-f-]{36})$/.exec(url.pathname);
      const eventsMatch = /^\/events\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (!syncMatch && !eventsMatch) return reject("path");
      const roomId = (syncMatch ?? eventsMatch)![1];
      const ticket = url.searchParams.get("ticket") ?? "";
      const channel = syncMatch ? "sync" : "events";

      if (eventsMatch) {
        const sinceRaw = url.searchParams.get("since") ?? "0";
        const since = Number(sinceRaw);
        if (!Number.isInteger(since) || since < 0) return reject("since");
        engine.eventsSince(roomId, since, 1);
        const { userId } = engine.consumeTicket(roomId, channel, ticket);
        eventsWss.handleUpgrade(req, socket, head, (ws) => {
          attachEventsSocket(engine, roomId, userId, since, ws);
        });
        return;
      }

      const { userId } = engine.consumeTicket(roomId, channel, ticket);
      syncWss.handleUpgrade(req, socket, head, (ws) => {
        const handle = engine.getRoomHandle(roomId);
        const sessionId = `sync_${crypto.randomUUID()}`;
        handle.socketRoom.handleSocketConnect({ sessionId, socket: ws as never, meta: { userId } });
        ws.on("close", () => handle.socketRoom.handleSocketClose(sessionId));
        ws.on("error", () => handle.socketRoom.handleSocketError(sessionId));
      });
    } catch {
      reject("error");
    }
  });

  return {
    engine,
    server,
    port: () => (server.address() as { port: number }).port,
    close: async () => {
      const stopped = engine.stop();
      for (const ws of [...syncWss.clients, ...eventsWss.clients]) ws.terminate();
      syncWss.close();
      eventsWss.close();
      const closed = server.listening ? new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) : Promise.resolve();
      await Promise.all([stopped, closed]);
    },
  };
}

function attachEventsSocket(engine: Engine, roomId: string, userId: string, since: number, ws: WebSocket) {
  ws.on("error", () => ws.terminate());
  const send = (msg: ServerMessage) => engine.sendSafe(ws, msg);
  let cursor = since;
  try {
    const highwater = engine.eventsSince(roomId, since, 1).currentCursor;
    while (true) {
      const page = engine.eventsSince(roomId, cursor, 250, highwater);
      for (const event of page.events) if (!send({ type: "event", event })) return;
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
  } catch {
    send({ type: "error", error: "invalid_cursor" });
    ws.close(4400, "invalid cursor");
    return;
  }
  const session = engine.addSession(roomId, userId, ws);
  ws.on("close", () => engine.removeSession(roomId, session.sessionId));
  ws.on("error", () => engine.removeSession(roomId, session.sessionId));
  const detail = engine.roomDetail(roomId);
  send({
    type: "ready",
    cursor,
    sessionId: session.sessionId,
    room: detail.room,
    members: detail.members,
    executors: [...(engine.getRoomHandle(roomId).sessions.values())].map((s) => ({
      sessionId: s.sessionId,
      userId: s.userId,
      ready: s.ready,
      agentId: s.agentId,
      busy: s.busy,
      scope: s.scope,
      background: s.background,
    })),

    triggers: engine.listTriggers(roomId),
  });
  ws.on("message", (data) => {
    session.lastSeen = engine.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      ws.close(4400, "bad message");
      return;
    }
    const msg = EventsClientMessage.safeParse(parsed);
    if (!msg.success) {
      ws.close(4400, "unsupported message");
      return;
    }
    if (msg.data.type === "executor.ready") {
      engine.setExecutorReady(roomId, session.sessionId, msg.data.ready, msg.data.agentId, msg.data.scope, msg.data.background);
      engine.tick();
    } else {
      engine.heartbeatSession(roomId, session.sessionId);
    }
  });
  engine.broadcastPresence(roomId);
}
