import { z } from "zod";
import { ASSISTANT_EAGERNESS, DEFAULT_EAGERNESS, MAX_ASSISTANT_COOLDOWN_MS } from "./assistant-policy";

export * from "./assistant-policy";
export * from "./prompts";
export * from "./direct-canvas";
export * from "./diagnostics";

const uuid = z.uuid();
const isoDate = z.iso.datetime();
export const shapeId = z.string().regex(/^shape:[A-Za-z0-9_-]{1,80}$/);

export const ExecutorScopeSchema = z.enum(["own", "room", "manual"]);
export const EvidenceSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("entry"), id: uuid }),
  z.strictObject({ kind: z.literal("shape"), id: shapeId }),
]);
export const EvidenceSourcesSchema = z.array(EvidenceSourceSchema).max(12);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const [y, m, d] = v.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, "invalid calendar date");

export const MAX_JSON_DEPTH = 12;
export const MAX_JSON_BYTES = 64 * 1024;

export function checkBoundedJson(value: unknown, maxDepth = MAX_JSON_DEPTH, maxKeys = 2000, maxString = 8192): boolean {
  let keys = 0;
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > maxDepth) return false;
    if (v === null) return true;
    const t = typeof v;
    if (t === "string") return (v as string).length <= maxString;
    if (t === "number") return Number.isFinite(v as number);
    if (t === "boolean") return true;
    if (t !== "object") return false;
    if (seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) {
      if (v.length > 1000) return false;
      for (const item of v) if (!walk(item, depth + 1)) return false;
      return true;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      keys += 1;
      if (keys > maxKeys) return false;
      if (k.length > 256) return false;
      if (!walk(val, depth + 1)) return false;
    }
    return true;
  };
  return walk(value, 0);
}

export function boundedJson(maxDepth = MAX_JSON_DEPTH, maxString = 8192, maxBytes = MAX_JSON_BYTES, maxKeys = 2000) {
  return z
    .unknown()
    .refine((v) => checkBoundedJson(v, maxDepth, maxKeys, maxString), "json exceeds depth/size bounds")
    .refine((v) => {
      try {
        return new TextEncoder().encode(JSON.stringify(v)).byteLength <= maxBytes;
      } catch {
        return false;
      }
    }, "json exceeds byte bound");
}

const FORBIDDEN_SPEC_KEYS = new Set(["url", "href", "expr", "calculate"]);
export function checkChartSpec(value: unknown, depth = 0): boolean {
  if (depth > 10 || value === null || typeof value !== "object") return depth <= 10;
  if (Array.isArray(value)) return value.every((v) => checkChartSpec(v, depth + 1));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SPEC_KEYS.has(k)) return false;
    if (k === "filter" && typeof v === "string") return false;
    if (!checkChartSpec(v, depth + 1)) return false;
  }
  return true;
}

const chartSpecSchema = boundedJson(10)
  .refine((v) => v !== null && typeof v === "object" && !Array.isArray(v), "chart spec must be an object")
  .refine(checkChartSpec, "chart spec contains forbidden keys");
const chartDataRow = z.record(z.string(), z.union([z.string().max(2048), z.number().finite(), z.boolean(), z.null()]));

const mapMarkerSchema = z.strictObject({
  lat: z.number().finite().min(-90).max(90).describe("Marker latitude"),
  lng: z.number().finite().min(-180).max(180).describe("Marker longitude"),
  label: z.string().min(1).max(200).describe("Place label"),
  note: z.string().max(500).optional().describe("Optional note, such as approximate location"),
});
const mapCenterSchema = z.strictObject({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});
export const MapDraftSchema = z.strictObject({
  type: z.literal("map"),
  title: z.string().min(1).max(200).describe("Map heading"),
  markers: z.array(mapMarkerSchema).min(1).max(100).describe("Places to pin on the map"),
  center: mapCenterSchema.optional().describe("Optional map center"),
  zoom: z.number().finite().min(0).max(22).optional().describe("Optional map zoom"),
  style: z.enum(["streets", "aquarelle", "light", "dark", "satellite", "outdoor"]).optional().describe("Map style; defaults to Aquarelle"),
  sourceNote: z.string().max(500).optional().describe("Source or reference for the map"),
});
export const LogoDraftSchema = z.strictObject({
  type: z.literal("logo"),
  domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i).max(255).describe("Company domain, for example stripe.com"),
  name: z.string().max(200).optional().describe("Company name"),
  note: z.string().max(500).optional().describe("Optional context shown with the logo"),
});

const calendarDate = z.iso.date().refine((value) => value >= "0001-01-01", "Date must be in years 0001–9999");
const calendarEvent = z.strictObject({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  start: calendarDate,
  end: calendarDate.optional(),
  description: z.string().max(4000).optional(),
  sourceNote: z.string().max(500).optional(),
}).refine((event) => !event.end || event.end >= event.start, "Event end must be on or after its start");
export const CalendarDraftSchema = z.strictObject({
  type: z.literal("calendar"),
  title: z.string().min(1).max(200).describe("Calendar heading"),
  events: z.array(calendarEvent).max(500).refine((events) => new Set(events.map(({ id }) => id)).size === events.length, "Event IDs must be unique").describe("All-day events; empty is allowed. End dates are inclusive."),
  month: z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/).optional().describe("Displayed month in YYYY-MM format"),
  selectedDate: calendarDate.nullable().optional().describe("Day to select in YYYY-MM-DD format; selection reveals its month"),
  sourceNote: z.string().max(500).optional().describe("Source for the calendar"),
});

export const NodeDraftSchema = z.discriminatedUnion("type", [
  CalendarDraftSchema,
  z.strictObject({ type: z.literal("markdown"), title: z.string().min(1).max(200), body: z.string().max(50_000) }),
  z.strictObject({
    type: z.literal("decision"),
    title: z.string().min(1).max(200),
    bullets: z.array(z.string().min(1).max(500)).max(50),
  }),
  z.strictObject({ type: z.literal("concept"), label: z.string().min(1).max(120), glyph: z.string().max(8).optional() }),
  z.strictObject({
    type: z.literal("table"),
    title: z.string().min(1).max(200),
    columns: z.array(z.string().min(1).max(200)).min(1).max(20),
    rows: z.array(z.array(z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()])).max(20)).max(500),
    sourceNote: z.string().max(500).optional(),
  }).refine((v) => v.rows.every((row) => row.length === v.columns.length), "row width must equal columns"),
  z.strictObject({
    type: z.literal("chart"),
    title: z.string().min(1).max(200),
    spec: chartSpecSchema,
    data: z.array(chartDataRow).max(1000),
    sourceNote: z.string().max(500).optional(),
  }),
  MapDraftSchema,
  LogoDraftSchema,
]).refine((v) => boundedJson(12, 50_000, MAX_JSON_BYTES, 20_000).safeParse(v).success, "draft exceeds JSON bounds");
export const SnapshotRecordSchema = boundedJson(16, 50_000, 96 * 1024, 20_000);
export type NodeDraft = z.infer<typeof NodeDraftSchema>;

export const UserSchema = z.strictObject({ id: uuid, name: z.string().min(1).max(80) });
export type User = z.infer<typeof UserSchema>;

export const AssistantSettingsSchema = z.strictObject({
  assistantThreshold: z.number().min(0).max(1),
  assistantCooldownMs: z.number().int().min(0).max(MAX_ASSISTANT_COOLDOWN_MS),
});
export type AssistantSettings = z.infer<typeof AssistantSettingsSchema>;

export const RoomSchema = z.strictObject({
  id: uuid,
  localCanvasId: uuid,
  name: z.string().min(1).max(120),
  code: z.string(),
  createdBy: uuid,
  createdAt: isoDate,
  updatedAt: isoDate,
  assistantPaused: z.boolean().optional().default(false),
  assistantEagerness: z.enum(ASSISTANT_EAGERNESS).optional().default(DEFAULT_EAGERNESS),
  assistantThreshold: AssistantSettingsSchema.shape.assistantThreshold.optional(),
  assistantCooldownMs: AssistantSettingsSchema.shape.assistantCooldownMs.optional(),
});
export type Room = z.infer<typeof RoomSchema>;

export const TriggerStatusSchema = z.enum(["pending", "offered", "running", "needs_claim", "done", "failed", "cancelled", "expired"]);
export const TriggerSchema = z.strictObject({
  id: uuid,
  causeEntryIds: z.array(z.string().max(80)).max(20),
  requestedBy: uuid,
  reason: z.string().max(1000),
  intent: z.enum(["answer", "capture", "update", "lookup", "evidence", "align"]),
  mode: z.enum(["act", "propose", "context"]),
  anchors: z.array(shapeId).max(64),
  confidence: z.number().min(0).max(1),
  status: TriggerStatusSchema,
  assigneeSessionId: z.string().max(128).nullable(),
  offerExpiresAt: z.number().int().nonnegative().nullable(),
  attempt: z.number().int().nonnegative(),
  runId: uuid.nullable(),
  source: z.enum(["explicit", "context", "accepted"]).optional(),
  createdAt: z.number().int().nonnegative().optional(),
  approvedRequest: z.string().max(4000).optional(),
  acceptedOfferId: uuid.optional(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

export const AgentStepSchema = boundedJson(8);
const entryBase = { id: uuid, roomId: uuid, seq: z.number().int().positive(), at: isoDate };

export const EntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...entryBase,
    kind: z.literal("message"),
    authorId: uuid,
    text: z.string().min(1).max(8000),
    anchors: z.array(shapeId).max(64),
    attachments: z.array(uuid).max(8),
    source: z.enum(["typed", "transcript"]).optional(),
    replyToEntryId: uuid.optional(),
  }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("system"),
    text: z.string().min(1).max(2000),
    authorId: uuid,
    shapeIds: z.array(shapeId).max(200),
  }),
  z.strictObject({ ...entryBase, kind: z.literal("trigger"), trigger: TriggerSchema }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("agent_turn"),
    triggerId: uuid,
    runId: uuid,
    byUserId: uuid,
    agentId: z.string().min(1).max(120),
    text: z.string().max(50_000),
    status: z.enum(["running", "done", "failed", "cancelled"]),
    steps: z.array(AgentStepSchema).max(200),
    touchedShapeIds: z.array(shapeId).max(500),
    sources: EvidenceSourcesSchema.optional(),
    hidden: z.boolean().optional(),
  }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("suggestion"),
    triggerId: uuid,
    runId: uuid,
    draft: NodeDraftSchema,
    status: z.enum(["open", "accepted", "dismissed", "outdated"]),
    shapeId: shapeId.nullable(),
    acceptedBy: uuid.nullable().optional(),
    text: z.string().max(20_000).optional(),
    sources: EvidenceSourcesSchema.optional(),
    targetShapeId: shapeId.optional(),
    expectedDraft: NodeDraftSchema.optional(),
    revision: z.string().max(128).optional(),
    resolvedBy: uuid.nullable().optional(),
  }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("offer"),
    triggerId: uuid,
    runId: uuid,
    title: z.string().min(1).max(200),
    request: z.string().min(1).max(4000),
    text: z.string().max(20_000),
    sources: EvidenceSourcesSchema,
    status: z.enum(["open", "accepted", "dismissed", "outdated"]),
    resolvedBy: uuid.nullable(),
    resultTriggerId: uuid.nullable(),
    revision: z.string().max(128),
  }),
]);
export type Entry = z.infer<typeof EntrySchema>;

export const RoomEventSchema = z.strictObject({
  cursor: z.number().int().nonnegative(),
  roomId: uuid,
  at: isoDate,
  type: z.literal("entry.upsert"),
  entry: EntrySchema,
});
export type RoomEvent = z.infer<typeof RoomEventSchema>;

export const ExecutorPresenceSchema = z.strictObject({
  sessionId: z.string().max(128),
  userId: uuid,
  ready: z.boolean(),
  agentId: z.string().max(120),
  busy: z.boolean(),
  scope: ExecutorScopeSchema.optional().default("own"),
  background: z.boolean().optional().default(false),
});
export type ExecutorPresence = z.infer<typeof ExecutorPresenceSchema>;

export const LeaseSchema = z.strictObject({
  runId: uuid,
  triggerId: uuid,
  attempt: z.number().int().nonnegative(),
  leaseToken: z.string().min(32).max(256),
  expiresAt: z.number().int().nonnegative(),
  entryId: uuid,
});
export type Lease = z.infer<typeof LeaseSchema>;

export const GeoColorSchema = z.enum([
  "black", "grey", "light-violet", "violet", "blue", "light-blue", "yellow",
  "orange", "green", "light-green", "light-red", "red", "white",
]).describe("Native tldraw shape color");

const diagramId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
export const DiagramInputSchema = z.strictObject({
  nodes: z.array(z.strictObject({
    id: diagramId.describe("Unique local node ID, not a canvas shape ID"),
    label: z.string().min(1).max(120).describe("Short label"),
    group: diagramId.optional().describe("Local group ID"),
    geo: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
    color: GeoColorSchema.optional(),
  })).min(1).max(40),
  edges: z.array(z.strictObject({ from: diagramId, to: diagramId, label: z.string().max(80).optional() })).max(80).default([]),
  groups: z.array(z.strictObject({ id: diagramId, label: z.string().min(1).max(120) })).max(10).default([]),
  direction: z.enum(["right", "down"]).default("right"),
  nearShapeId: shapeId.optional(),
}).refine((diagram) => {
  const nodes = new Set(diagram.nodes.map(node => node.id));
  const groups = new Set(diagram.groups.map(group => group.id));
  return nodes.size === diagram.nodes.length && groups.size === diagram.groups.length
    && diagram.nodes.every(node => !node.group || groups.has(node.group))
    && diagram.groups.every(group => diagram.nodes.some(node => node.group === group.id))
    && diagram.edges.every(edge => nodes.has(edge.from) && nodes.has(edge.to) && edge.from !== edge.to);
}, "Diagram IDs must be unique, groups nonempty, and references must resolve to distinct nodes");
export type DiagramInput = z.infer<typeof DiagramInputSchema>;

export const MutationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("add"),
    draft: NodeDraftSchema,
    shapeId: shapeId.optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    nearShapeId: shapeId.optional(),
  }),
  z.strictObject({ type: z.literal("update"), shapeId, draft: NodeDraftSchema }),
  z.strictObject({
    type: z.literal("connect"),
    from: shapeId,
    to: shapeId,
    label: z.string().max(200).optional(),
  }),
  z.strictObject({
    type: z.literal("arrange"),
    shapeIds: z.array(shapeId).min(1).max(200),
    layout: z.enum(["row", "column", "grid"]),
  }),
  z.strictObject({
    type: z.literal("group"),
    shapeIds: z.array(shapeId).min(2).max(200).describe("Existing nodes to group like Cmd/Ctrl+G"),
  }),
  z.strictObject({ type: z.literal("style"), shapeId, color: GeoColorSchema }),
  DiagramInputSchema.safeExtend({ type: z.literal("diagram") }),
  z.strictObject({ type: z.literal("label"), shapeId, text: z.string().min(1).max(120) }),
]);
export type Mutation = z.infer<typeof MutationSchema>;

const contributionBody = { text: z.string().min(1).max(20_000), sources: EvidenceSourcesSchema };
export const AssistantResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("silent") }),
  z.strictObject({ kind: z.literal("reply"), ...contributionBody }),
  z.strictObject({ kind: z.literal("offer"), ...contributionBody, title: z.string().min(1).max(200), request: z.string().min(1).max(4000) }),
  z.strictObject({ kind: z.literal("draft"), ...contributionBody, draft: NodeDraftSchema, targetShapeId: shapeId.optional() }),
  z.strictObject({ kind: z.literal("act"), ...contributionBody, operations: z.array(MutationSchema).min(1).max(8) }),
]);
export type AssistantResult = z.infer<typeof AssistantResultSchema>;
export const RunCompleteInput = z.strictObject({ id: uuid, revision: z.string().max(128), result: AssistantResultSchema });

export const CanvasReadInput = z.strictObject({ scope: z.enum(["summary", "selection", "full"]), shapeIds: z.array(shapeId).max(500).optional() });
export const CanvasToolInputs = {
  getCanvas: CanvasReadInput,
  addDiagram: DiagramInputSchema.safeExtend({ requestId: uuid.optional() }),
  addNode: MutationSchema.options[0].omit({ type: true }).extend({ requestId: uuid.optional() }),
  updateNode: MutationSchema.options[1].omit({ type: true }).extend({ requestId: uuid.optional() }),
  connectNodes: MutationSchema.options[2].omit({ type: true }).extend({ requestId: uuid.optional() }),
  arrange: MutationSchema.options[3].omit({ type: true }).extend({ requestId: uuid.optional() }),
  proposeNode: z.strictObject({ draft: NodeDraftSchema, requestId: uuid.optional() }),
};

export const RegisterInput = z.strictObject({
  userId: uuid,
  secret: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1).max(80),
});
export const PatchMeInput = z.strictObject({ name: z.string().min(1).max(80) });
export const PatchRoomInput = z.strictObject({
  name: z.string().min(1).max(120).optional(),
  assistantPaused: z.boolean().optional(),
  assistantEagerness: z.enum(ASSISTANT_EAGERNESS).optional(),
  assistantThreshold: AssistantSettingsSchema.shape.assistantThreshold.optional(),
  assistantCooldownMs: AssistantSettingsSchema.shape.assistantCooldownMs.optional(),
}).refine((value) => Object.values(value).some((field) => field !== undefined), "at least one field is required");
export const JoinInput = z.strictObject({ code: z.string().min(1).max(32) });
export const ImportedMessageInput = z.strictObject({
  id: uuid,
  text: z.string().min(1).max(8000),
  at: isoDate,
  anchors: z.array(shapeId).max(64).optional(),
  attachments: z.array(uuid).max(8).optional(),
  source: z.enum(["typed", "transcript"]).optional(),
  replyToEntryId: uuid.optional(),
});
export const CreateRoomInput = z.strictObject({
  localCanvasId: uuid,
  name: z.string().min(1).max(120),
  records: z.array(SnapshotRecordSchema).max(5000).optional(),
  messages: z.array(ImportedMessageInput).max(500).optional(),
  assetIds: z.array(uuid).max(100).optional(),
});
export const PostMessageInput = z.strictObject({
  id: uuid,
  text: z.string().min(1).max(8000),
  anchors: z.array(shapeId).max(64).optional(),
  attachments: z.array(uuid).max(8).optional(),
  source: z.enum(["typed", "transcript"]).optional(),
  replyToEntryId: uuid.optional(),
});
export const SocketTicketInput = z.strictObject({ channel: z.enum(["sync", "events"]) });
export const ClaimInput = z.strictObject({ sessionId: z.string().min(1).max(128), manual: z.boolean().optional() });
export const RetryInput = z.strictObject({ id: uuid });
export const MutateInput = z.strictObject({ id: uuid, operations: z.array(MutationSchema).min(1).max(100) });
export const SuggestionInput = z.strictObject({ id: uuid, draft: NodeDraftSchema });
export const ResolveSuggestionInput = z.strictObject({ resolution: z.enum(["accepted", "dismissed"]) });
export const ResolveOfferInput = z.strictObject({ resolution: z.enum(["accepted", "dismissed"]) });
export const DataQueryInput = z
  .strictObject({
    source: z.literal("demo-metrics"),
    metric: z.enum(["throughput", "latencyMs", "errorRate"]),
    from: isoDay.optional(),
    to: isoDay.optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, "from must be <= to");
export const RunPatchInput = z.strictObject({
  id: uuid,
  text: z.string().max(50_000).optional(),
  steps: z.array(boundedJson(8)).max(200).optional(),
  status: z.enum(["done", "failed", "cancelled"]).optional(),
});
export const TranscriptInput = z.strictObject({ id: uuid, text: z.string().trim().min(1).max(8000), isFinal: z.boolean() });
export type TranscriptInput = z.infer<typeof TranscriptInput>;
export const LiveTranscriptSchema = z.strictObject({ id: uuid, text: z.string().max(8000), authorId: uuid, at: isoDate, sessionId: z.string() });
export type LiveTranscript = z.infer<typeof LiveTranscriptSchema>;

export const EventsClientMessage = z.discriminatedUnion("type", [
  TranscriptInput.extend({ type: z.literal("transcript") }),
  z.strictObject({ type: z.literal("transcript.clear") }),
  z.strictObject({
    type: z.literal("executor.ready"),
    ready: z.boolean(),
    agentId: z.string().min(1).max(120),
    scope: ExecutorScopeSchema.optional().default("own"),
    background: z.boolean().optional().default(false),
  }),
  z.strictObject({ type: z.literal("heartbeat") }),
]);

export const EventsServerMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("event"), event: RoomEventSchema }),
  z.strictObject({ type: z.literal("transcript"), sessionId: z.string(), caption: LiveTranscriptSchema.nullable() }),
  z.strictObject({ type: z.literal("transcript.ack"), id: uuid }),
  z.strictObject({ type: z.literal("transcript.error"), id: uuid, error: z.string() }),
  z.strictObject({ type: z.literal("ready"), cursor: z.number().int().nonnegative(), sessionId: z.string(), room: RoomSchema, members: z.array(UserSchema), executors: z.array(ExecutorPresenceSchema), triggers: z.array(TriggerSchema), transcripts: z.array(LiveTranscriptSchema).optional().default([]) }),
  z.strictObject({ type: z.literal("presence"), room: RoomSchema, members: z.array(UserSchema), executors: z.array(ExecutorPresenceSchema) }),
  z.strictObject({ type: z.literal("error"), error: z.string() }),
]);
export type ServerMessage = z.infer<typeof EventsServerMessage>;

export type DataQuery = z.infer<typeof DataQueryInput>;
export const ALLOWED_ASSET_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/octet-stream",
]);
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const ROOM_CODE_LENGTH = 10;
