import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ZodError, type z } from "zod";
import {
  ALLOWED_ASSET_TYPES,
  CanvasReadInput,
  ClaimInput,
  CreateRoomInput,
  DataQueryInput,
  JoinInput,
  MAX_ASSET_BYTES,
  MutateInput,
  PatchMeInput,
  PatchRoomInput,
  PostMessageInput,
  RegisterInput,
  ResolveSuggestionInput,
  RetryInput,
  RunPatchInput,
  SocketTicketInput,
  SuggestionInput,
} from "@kan/protocol";
import type { Engine } from "./engine";
import { ApiError, badRequest, tooLarge, tooMany } from "./errors";

const MAX_JSON_BODY = 8 * 1024 * 1024;

type Authed = { Variables: { user: { id: string; name: string } } };

class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  blocked(key: string, limit: number) {
    const bucket = this.buckets.get(key);
    return !!bucket && bucket.resetAt > Date.now() && bucket.count >= limit;
  }
  allow(key: string, limit: number, windowMs = 60_000): boolean {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 10_000) return false;
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    return ++bucket.count <= limit;
  }
}

async function boundedBody(c: Context, maxBytes: number): Promise<Buffer> {
  if (Number(c.req.header("content-length") ?? 0) > maxBytes) {
    c.header("Connection", "close");
    throw tooLarge();
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiError(408, "request_timeout", "body read timed out")), 5000);
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    c.header("Connection", "close");
    if (error instanceof ApiError) throw error;
    throw badRequest("could not read body");
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function boundedJson<T>(c: Context, schema: z.ZodType<T>, maxBytes = MAX_JSON_BODY): Promise<T> {
  const text = (await boundedBody(c, maxBytes)).toString("utf8");
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest("body is not valid JSON");
  }
  try {
    return schema.parse(raw);
  } catch (e) {
    if (e instanceof ZodError) {
      throw new ApiError(400, "invalid_input", e.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.code}`).join("; ") || "invalid input");
    }
    throw e;
  }
}

function clientIp(c: Context): string {
  return getConnInfo(c as unknown as Parameters<typeof getConnInfo>[0]).remote.address ?? "unknown";
}

function paginationLimit(c: Context) {
  const limit = Number(c.req.query("limit") ?? "100");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest("invalid limit");
  return limit;
}

export function createApp(engine: Engine, allowedOrigins: string[]) {
  const app = new Hono<Authed>();
  const limiter = new RateLimiter();
  const rateLimit = limiter.allow.bind(limiter);
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !allowedOrigins.includes(origin)) { c.header("Connection", "close"); return c.json({ error: "forbidden" }, 403); }
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
    }
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
      return c.body(null, 204);
    }
    if (/\/runs\/|\/data\/query$/.test(c.req.path) && !rateLimit(`runner:${clientIp(c)}`, 600)) throw tooMany();
    await next();
  });

  app.onError((err, c) => {
    if (c.req.raw.body) c.header("Connection", "close");
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status as never);
    console.error("room-server internal_error");
    return c.json({ error: "internal_error", message: "internal error" }, 500);
  });

  const auth = async (c: Context<Authed>, next: () => Promise<void>) => {
    if (!rateLimit(`auth:${clientIp(c)}`, 600)) throw tooMany();
    const failureKey = `auth-failed:${clientIp(c)}`;
    if (limiter.blocked(failureKey, 20)) throw tooMany();
    try { c.set("user", engine.authenticate(c.req.header("authorization"))); }
    catch (error) { rateLimit(failureKey, 20); throw error; }
    await next();
  };

  app.get("/health", (c) =>
    c.json({ ok: true, classifier: engine.classifier ? "jev" : "disabled", video: !!engine.video }),
  );

  app.post("/users/register", async (c) => {
    if (!rateLimit(`register:${clientIp(c)}`, 20, 60_000)) throw tooMany();
    const input = await boundedJson(c, RegisterInput, 64 * 1024);
    const { user } = engine.registerUser(input);
    return c.json({ user });
  });

  app.get("/me", auth, (c) => c.json({ user: c.get("user") }));

  app.patch("/me", auth, async (c) => {
    const input = await boundedJson(c, PatchMeInput);
    engine.renameUser(c.get("user").id, input.name);
    return c.json({ user: { id: c.get("user").id, name: input.name } });
  });

  app.get("/rooms", auth, (c) => c.json({ rooms: engine.listRooms(c.get("user").id) }));

  app.post("/rooms", auth, async (c) => {
    if (!rateLimit(`publish:${c.get("user").id}`, 30, 60_000)) throw tooMany();
    const input = await boundedJson(c, CreateRoomInput);
    const result = engine.publishRoom(c.get("user"), input);
    return c.json(result);
  });

  app.post("/rooms/join", auth, async (c) => {
    if (!rateLimit(`join:${clientIp(c)}`, 30, 60_000)) throw tooMany();
    const input = await boundedJson(c, JoinInput, 16 * 1024);
    return c.json(engine.joinRoom(c.get("user").id, input.code));
  });

  app.get("/rooms/:id", auth, (c) => {
    engine.requireMember(c.req.param("id")!, c.get("user").id);
    return c.json(engine.roomDetail(c.req.param("id")!));
  });

  app.patch("/rooms/:id", auth, async (c) => {
    const input = await boundedJson(c, PatchRoomInput);
    return c.json(engine.renameRoom(c.get("user"), c.req.param("id")!, input.name));
  });

  app.post("/rooms/:id/open", auth, (c) => c.json(engine.openRoom(c.get("user").id, c.req.param("id")!)));

  app.post("/assets", auth, async (c) => {
    if (!rateLimit(`asset:${c.get("user").id}`, 60, 60_000)) throw tooMany();
    const contentType = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_ASSET_TYPES.has(contentType)) throw badRequest("unsupported content type");
    const buf = await boundedBody(c, MAX_ASSET_BYTES);
    return c.json(engine.createAsset(c.get("user").id, contentType, buf));
  });

  app.get("/assets/:id", auth, (c) => {
    const asset = engine.getAsset(c.req.param("id")!, c.get("user").id);
    return new Response(new Uint8Array(asset.data), {
      headers: {
        "content-type": asset.content_type,
        "content-length": String(asset.data.byteLength),
        "x-content-type-options": "nosniff",
        "content-disposition": `inline; filename="${c.req.param("id")!}"`,
        "cache-control": "private, max-age=3600",
      },
    });
  });

  app.get("/rooms/:id/thread", auth, (c) => {
    engine.requireMember(c.req.param("id")!, c.get("user").id);
    const afterSeq = Number(c.req.query("afterSeq") ?? "0");
    const limit = paginationLimit(c);
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw badRequest("invalid afterSeq");
    return c.json(engine.thread(c.req.param("id")!, afterSeq, limit));
  });

  app.get("/rooms/:id/events", auth, (c) => {
    engine.requireMember(c.req.param("id")!, c.get("user").id);
    const since = Number(c.req.query("since") ?? "0");
    const limit = paginationLimit(c);
    return c.json(engine.eventsSince(c.req.param("id")!, since, limit));
  });

  app.post("/rooms/:id/messages", auth, async (c) => {
    if (!rateLimit(`msg:${c.get("user").id}`, 240, 60_000)) throw tooMany();
    const input = await boundedJson(c, PostMessageInput);
    return c.json(engine.postMessage(c.get("user"), c.req.param("id")!, input));
  });

  app.post("/rooms/:id/socket-ticket", auth, async (c) => {
    if (!rateLimit(`ticket:${c.get("user").id}`, 120)) throw tooMany();
    const input = await boundedJson(c, SocketTicketInput, 16 * 1024);
    return c.json(engine.createTicket(c.get("user").id, c.req.param("id")!, input.channel));
  });

  app.get("/rooms/:id/canvas", auth, (c) => {
    engine.requireMember(c.req.param("id")!, c.get("user").id);
    return c.json({ records: engine.canvasRecords(c.req.param("id")!) });
  });

  app.get("/rooms/:id/canvas/summary", auth, (c) => {
    engine.requireMember(c.req.param("id")!, c.get("user").id);
    return c.json(engine.canvasSummary(c.req.param("id")!));
  });

  app.get("/rooms/:id/triggers", auth, (c) => {
    engine.requireMember(c.req.param("id")!, c.get("user").id);
    return c.json({ triggers: engine.listTriggers(c.req.param("id")!) });
  });

  app.post("/rooms/:id/triggers/:triggerId/claim", auth, async (c) => {
    const input = await boundedJson(c, ClaimInput, 16 * 1024);
    return c.json({ lease: engine.claimTrigger(c.get("user").id, c.req.param("id")!, c.req.param("triggerId")!, input) });
  });

  app.post("/rooms/:id/triggers/:triggerId/retry", auth, async (c) => {
    const input = await boundedJson(c, RetryInput, 16 * 1024);
    return c.json(engine.retryTrigger(c.get("user").id, c.req.param("id")!, c.req.param("triggerId")!, input.id));
  });

  app.post("/rooms/:id/suggestions/:entryId/resolve", auth, async (c) => {
    const input = await boundedJson(c, ResolveSuggestionInput, 16 * 1024);
    return c.json(engine.resolveSuggestion(c.get("user").id, c.req.param("id")!, c.req.param("entryId")!, input.resolution));
  });

  app.get("/rooms/:id/video-token", auth, async (c) => {
    return c.json(await engine.videoToken(c.get("user").id, c.req.param("id")!));
  });

  // runner endpoints: lease-token auth
  app.post("/rooms/:id/runs/:runId/heartbeat", (c) =>
    c.json(engine.heartbeatRun(c.req.param("id")!, c.req.param("runId")!, c.req.header("authorization"))),
  );

  app.get("/rooms/:id/runs/:runId/context", (c) =>
    c.json(engine.runContext(c.req.param("id")!, c.req.param("runId")!, c.req.header("authorization"))),
  );

  app.get("/rooms/:id/runs/:runId/canvas", (c) => {
    const input = CanvasReadInput.safeParse({ scope: c.req.query("scope") ?? "summary", shapeIds: c.req.queries("shapeIds") });
    if (!input.success) throw badRequest("invalid canvas query");
    return c.json(engine.runCanvas(c.req.param("id")!, c.req.param("runId")!, c.req.header("authorization"), input.data));
  });

  app.patch("/rooms/:id/runs/:runId", async (c) => {
    const input = await boundedJson(c, RunPatchInput);
    return c.json(engine.patchRun(c.req.param("id")!, c.req.param("runId")!, c.req.header("authorization"), input));
  });

  app.post("/rooms/:id/runs/:runId/mutate", async (c) => {
    const input = await boundedJson(c, MutateInput);
    return c.json(engine.mutate(c.req.param("id")!, c.req.param("runId")!, c.req.header("authorization"), input));
  });

  app.post("/rooms/:id/runs/:runId/suggestions", async (c) => {
    const input = await boundedJson(c, SuggestionInput);
    return c.json(engine.createSuggestion(c.req.param("id")!, c.req.param("runId")!, c.req.header("authorization"), input));
  });

  app.post("/rooms/:id/data/query", async (c) => {
    const input = await boundedJson(c, DataQueryInput, 16 * 1024);
    return c.json(engine.dataQuery(c.req.param("id")!, c.req.header("authorization"), input));
  });

  return app;
}
