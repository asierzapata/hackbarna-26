import { z } from "zod";

export const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type CellValue = z.infer<typeof cellValue>;

export const chartKind = z.enum(["bar", "line", "area", "pie"]);
export const chartSeries = z.object({
  key: z.string().describe("Field in each data row holding this series' value"),
  label: z.string().optional().describe("Legend label; defaults to key"),
});
export const chartSpec = z.object({
  kind: chartKind,
  x: z.string().describe("Field in each data row used for the x axis / pie slice label"),
  series: z.array(chartSeries).min(1).describe("One entry per plotted series. Pie charts use only the first."),
  stacked: z.boolean().optional(),
  yLabel: z.string().optional(),
});

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
export const mapMarker = z.object({
  lat: latitude,
  lng: longitude,
  label: z.string(),
  note: z.string().optional(),
});
export const mapCenter = z.object({ lat: latitude, lng: longitude });
export const mapStyle = z.enum(["streets", "aquarelle", "light", "dark", "satellite", "outdoor"]);

export const markdownDraft = z.object({
  type: z.literal("markdown"),
  title: z.string(),
  body: z.string().describe("GitHub-flavoured markdown"),
});
export const chartDraft = z.object({
  type: z.literal("chart"),
  title: z.string(),
  spec: chartSpec,
  data: z.array(z.record(z.string(), cellValue)).min(1),
  sourceNote: z.string().optional().describe("Where the numbers came from, shown below the title"),
});
export const tableDraft = z.object({
  type: z.literal("table"),
  title: z.string(),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(cellValue)),
  highlightRow: z.number().int().nonnegative().optional(),
  sourceNote: z.string().optional(),
});
export const imageDraft = z.object({
  type: z.literal("image"),
  title: z.string().optional(),
  src: z.string().url(),
  alt: z.string(),
  caption: z.string().optional(),
});
export const mapDraft = z.object({
  type: z.literal("map"),
  title: z.string(),
  markers: z.array(mapMarker).min(1).describe("Pins; the view fits all of them unless center/zoom are given"),
  center: mapCenter.optional(),
  zoom: z.number().min(0).max(22).optional(),
  style: mapStyle.optional().describe("Defaults to Aquarelle"),
});
export const logoDraft = z.object({
  type: z.literal("logo"),
  domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i).describe("Company domain, e.g. stripe.com"),
  name: z.string().optional(),
  note: z.string().optional().describe("One line, e.g. 'payments provider, option B'"),
});

export const dateOnly = z.iso.date().refine((value) => value >= "0001-01-01", {
  message: "Date must be in years 0001–9999",
}).describe("Calendar date in YYYY-MM-DD format, without a time or timezone");
export const calendarMonth = z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/)
  .describe("Displayed month in YYYY-MM format, years 0001–9999");
export const datedEvent = z.object({
  id: z.string().min(1).describe("Stable event ID, unique within this node"),
  title: z.string().min(1).describe("Event or milestone label"),
  start: dateOnly.describe("First day of the event, inclusive"),
  end: dateOnly.optional().describe("Last day, inclusive; omit for a single-day event"),
  description: z.string().optional().describe("Details shown when exploring the event"),
  sourceNote: z.string().optional().describe("Source or reference for this event"),
}).refine((event) => !event.end || event.end >= event.start, {
  message: "Event end must be on or after its start",
  path: ["end"],
});
export type DatedEvent = z.infer<typeof datedEvent>;
const datedEvents = z.array(datedEvent).refine(
  (events) => new Set(events.map(({ id }) => id)).size === events.length,
  { message: "Event IDs must be unique within the node" },
).describe("Dated events; may be empty and supplied in any order");
export const timelineDraft = z.object({
  type: z.literal("timeline"),
  title: z.string().describe("Timeline heading"),
  events: datedEvents,
  sourceNote: z.string().optional().describe("Source for the timeline"),
});
export const calendarDraft = z.object({
  type: z.literal("calendar"),
  title: z.string().describe("Calendar heading"),
  events: datedEvents,
  month: calendarMonth.optional().describe("Initial month; defaults to earliest event or current month"),
  sourceNote: z.string().optional().describe("Source for the calendar"),
});

export const nodeDraft = z.discriminatedUnion("type", [
  markdownDraft,
  chartDraft,
  tableDraft,
  imageDraft,
  mapDraft,
  logoDraft,
  timelineDraft,
  calendarDraft,
]);
export type NodeDraft = z.infer<typeof nodeDraft>;
export type NodeType = NodeDraft["type"];

const geometryPatch = {
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
};
export const nodePatch = z.discriminatedUnion("type", [
  markdownDraft.partial().required({ type: true }).extend(geometryPatch),
  chartDraft.partial().required({ type: true }).extend({
    ...geometryPatch,
    hiddenSeries: z.array(z.string()).optional(),
    focusX: z.string().nullable().optional(),
  }),
  tableDraft.partial().required({ type: true }).extend({
    ...geometryPatch,
    highlightRow: z.number().int().min(-1).optional(),
    selectedRows: z.array(z.number().int().nonnegative()).optional(),
    sortBy: z.object({
      column: z.number().int().nonnegative(),
      dir: z.enum(["asc", "desc"]),
    }).nullable().optional(),
  }),
  imageDraft.partial().required({ type: true }).extend(geometryPatch),
  mapDraft.partial().required({ type: true }).extend({
    ...geometryPatch,
    selectedMarker: z.number().int().min(-1).optional(),
  }),
  logoDraft.partial().required({ type: true }).extend(geometryPatch),
  timelineDraft.partial().required({ type: true }).extend({
    ...geometryPatch,
    selectedEventId: z.string().nullable().optional().describe("Expanded event ID; null collapses all entries"),
  }),
  calendarDraft.partial().required({ type: true }).extend({
    ...geometryPatch,
    selectedDate: dateOnly.nullable().optional().describe("Day to inspect; null clears selection. Selecting a day also reveals its month."),
  }),
]);
export type NodePatch = z.infer<typeof nodePatch>;

export const provenance = z.object({
  entryId: z.string(),
  runId: z.string().optional(),
  agentId: z.string().optional(),
  byUserId: z.string().optional(),
});
export type Provenance = z.infer<typeof provenance>;

export const addNodeInput = z.object({
  draft: nodeDraft,
  near: z.object({ shapeId: z.string() }).optional().describe("Place next to this shape"),
  at: z.object({ x: z.number(), y: z.number() }).optional().describe("Explicit page position; overrides near"),
  provenance: provenance.optional(),
});
export const updateNodeInput = z.object({
  shapeId: z.string(),
  patch: nodePatch.describe("Typed partial draft and geometry for the node"),
});
export const removeNodesInput = z.object({
  shapeIds: z.array(z.string()).min(1),
});
export const connectNodesInput = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
});
export const arrangeInput = z.object({
  shapeIds: z.array(z.string()).min(1),
  layout: z.enum(["grid", "row", "column"]),
  gap: z.number().optional(),
});
export const getCanvasInput = z.object({
  scope: z.enum(["summary", "selection", "viewport", "full"]).default("summary"),
  shapeIds: z.array(z.string()).optional(),
});

export type AddNodeInput = z.infer<typeof addNodeInput>;
export type UpdateNodeInput = z.infer<typeof updateNodeInput>;
export type RemoveNodesInput = z.infer<typeof removeNodesInput>;
export type ConnectNodesInput = z.infer<typeof connectNodesInput>;
export type ArrangeInput = z.infer<typeof arrangeInput>;
export type GetCanvasInput = z.infer<typeof getCanvasInput>;

export const toolSchemas = {
  addNode: addNodeInput,
  updateNode: updateNodeInput,
  removeNodes: removeNodesInput,
  connectNodes: connectNodesInput,
  arrange: arrangeInput,
  getCanvas: getCanvasInput,
};
