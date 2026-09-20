import { z } from "zod";

export const cellValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type CellValue = z.infer<typeof cellValue>;

export const chartKind = z.enum(["bar", "line", "area", "pie"]);
export const chartSeries = z.object({
  key: z.string().describe("Field in each data row holding this series' value"),
  label: z.string().optional().describe("Legend label; defaults to key"),
});
export const chartSpec = z.object({
  kind: chartKind,
  x: z
    .string()
    .describe("Field in each data row used for the x axis / pie slice label"),
  series: z
    .array(chartSeries)
    .min(1)
    .describe("One entry per plotted series. Pie charts use only the first."),
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
export const mapStyle = z.enum([
  "streets",
  "aquarelle",
  "light",
  "dark",
  "satellite",
  "outdoor",
]);

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
  sourceNote: z
    .string()
    .optional()
    .describe("Where the numbers came from, shown below the title"),
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
  markers: z
    .array(mapMarker)
    .min(1)
    .describe("Pins; the view fits all of them unless center/zoom are given"),
  center: mapCenter.optional(),
  zoom: z.number().min(0).max(22).optional(),
  style: mapStyle.optional().describe("Defaults to Aquarelle"),
  sourceNote: z.string().optional().describe("Source or reference for the map"),
});
export const logoDraft = z.object({
  type: z.literal("logo"),
  domain: z
    .string()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)
    .describe("Company domain, e.g. stripe.com"),
  name: z.string().optional(),
  note: z
    .string()
    .optional()
    .describe("One line, e.g. 'payments provider, option B'"),
});

export const dateOnly = z.iso
  .date()
  .refine((value) => value >= "0001-01-01", {
    message: "Date must be in years 0001–9999",
  })
  .describe("Calendar date in YYYY-MM-DD format, without a time or timezone");
export const calendarMonth = z
  .string()
  .regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/)
  .describe("Displayed month in YYYY-MM format, years 0001–9999");
export const datedEvent = z
  .object({
    id: z.string().min(1).describe("Stable event ID, unique within this node"),
    title: z.string().min(1).describe("Event or milestone label"),
    start: dateOnly.describe("First day of the event, inclusive"),
    end: dateOnly
      .optional()
      .describe("Last day, inclusive; omit for a single-day event"),
    description: z
      .string()
      .optional()
      .describe("Details shown when exploring the event"),
    sourceNote: z
      .string()
      .optional()
      .describe("Source or reference for this event"),
  })
  .refine((event) => !event.end || event.end >= event.start, {
    message: "Event end must be on or after its start",
    path: ["end"],
  });
export type DatedEvent = z.infer<typeof datedEvent>;
const datedEvents = z
  .array(datedEvent)
  .refine(
    (events) => new Set(events.map(({ id }) => id)).size === events.length,
    { message: "Event IDs must be unique within the node" },
  )
  .describe("Dated events; may be empty and supplied in any order");
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
  month: calendarMonth
    .optional()
    .describe("Initial month; defaults to earliest event or current month"),
  selectedDate: dateOnly.nullable().optional().describe("Day to select; selection reveals its month"),
  sourceNote: z.string().optional().describe("Source for the calendar"),
});
export const geoShapeKind = z.enum([
  "cloud",
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "pentagon",
  "hexagon",
  "octagon",
  "star",
  "rhombus",
  "rhombus-2",
  "trapezoid",
  "arrow-right",
  "arrow-left",
  "arrow-up",
  "arrow-down",
  "x-box",
  "check-box",
  "heart",
]).describe("Native tldraw geo kind. Use rectangle for a box or ellipse for a circle.");
export const geoDraft = z.object({
  type: z.literal("geo"),
  geo: geoShapeKind,
  text: z.string().optional().describe("Text inside the native shape"),
  w: z.number().positive().optional().describe("Width in page pixels; ellipse accepts independent width and height for ovals"),
  h: z.number().positive().optional().describe("Height in page pixels; use the same value as w for a circle, or omit both for the default square"),
}).describe("Exact syntax: { type: 'geo', geo: 'rectangle', text: 'Label', w: 240, h: 120 }; a circle uses { type: 'geo', geo: 'ellipse', w: 160, h: 160 }, while unequal w and h make an oval.");

export const nodeDraft = z.discriminatedUnion("type", [
  markdownDraft,
  chartDraft,
  tableDraft,
  imageDraft,
  mapDraft,
  logoDraft,
  timelineDraft,
  calendarDraft,
  geoDraft,
]);
export type NodeDraft = z.infer<typeof nodeDraft>;
export type NodeType = NodeDraft["type"];

const geometryPatch = {
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
};
const geoShapePatch = z.strictObject({
  type: z.literal("geo").describe("A normal tldraw box or geometric shape"),
  color: z.enum([
    "black", "grey", "light-violet", "violet", "blue", "light-blue", "yellow",
    "orange", "green", "light-green", "light-red", "red", "white",
  ]).optional().describe("Native tldraw shape color"),
  text: z.string().optional().describe("Text inside the existing shape"),
  ...geometryPatch,
});

export const nodePatch = z.discriminatedUnion("type", [
  markdownDraft.partial().required({ type: true }).extend(geometryPatch),
  chartDraft
    .partial()
    .required({ type: true })
    .extend({
      ...geometryPatch,
      hiddenSeries: z.array(z.string()).optional(),
      focusX: z.string().nullable().optional(),
    }),
  tableDraft
    .partial()
    .required({ type: true })
    .extend({
      ...geometryPatch,
      highlightRow: z.number().int().min(-1).optional(),
      selectedRows: z.array(z.number().int().nonnegative()).optional(),
      sortBy: z
        .object({
          column: z.number().int().nonnegative(),
          dir: z.enum(["asc", "desc"]),
        })
        .nullable()
        .optional(),
    }),
  imageDraft.partial().required({ type: true }).extend(geometryPatch),
  mapDraft
    .partial()
    .required({ type: true })
    .extend({
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
  geoShapePatch,
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
  near: z
    .object({ shapeId: z.string() })
    .optional()
    .describe("Place next to this shape"),
  at: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe("Explicit page position; overrides near"),
  provenance: provenance.optional(),
});
export const addMermaidDiagramInput = z.object({
  source: z.string().min(1).describe("Mermaid source for a native editable diagram"),
  at: z.object({ x: z.number(), y: z.number() }).optional().describe("Top-left page position; defaults to the viewport center"),
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
export const focusNodesInput = z.object({
  shapeIds: z.array(z.string()).min(1).describe("Existing shape IDs to fit in the camera; every ID must be on the current page"),
});
export const groupNodesInput = z.object({
  shapeIds: z.array(z.string()).min(2).describe("Existing canvas node IDs to place in one group"),
});
export const getCanvasInput = z.object({
  scope: z
    .enum(["summary", "selection", "viewport", "full"])
    .default("summary"),
  shapeIds: z.array(z.string()).optional(),
});

export type AddNodeInput = z.infer<typeof addNodeInput>;
export type AddMermaidDiagramInput = z.infer<typeof addMermaidDiagramInput>;
export type UpdateNodeInput = z.infer<typeof updateNodeInput>;
export type RemoveNodesInput = z.infer<typeof removeNodesInput>;
export type ConnectNodesInput = z.infer<typeof connectNodesInput>;
export type ArrangeInput = z.infer<typeof arrangeInput>;
export type FocusNodesInput = z.infer<typeof focusNodesInput>;
export type GroupNodesInput = z.infer<typeof groupNodesInput>;
export type GetCanvasInput = z.infer<typeof getCanvasInput>;

export const toolSchemas = {
  addNode: addNodeInput,
  addMermaidDiagram: addMermaidDiagramInput,
  updateNode: updateNodeInput,
  removeNodes: removeNodesInput,
  connectNodes: connectNodesInput,
  arrange: arrangeInput,
  focusNodes: focusNodesInput,
  groupNodes: groupNodesInput,
  getCanvas: getCanvasInput,
};
