import { T, type TLBaseShape } from "tldraw";

import type { CellValue, DatedEvent } from "../schema";

export type ChartSpec = {
  kind: "bar" | "line" | "area" | "pie";
  x: string;
  series: { key: string; label?: string }[];
  stacked?: boolean;
  yLabel?: string;
};

export type MapMarker = {
  lat: number;
  lng: number;
  label: string;
  note?: string;
};

export type MapNodeStyle = "streets" | "light" | "dark" | "satellite" | "outdoor";

export type MarkdownShapeProps = {
  w: number;
  h: number;
  title: string;
  body: string;
};

export type ChartShapeProps = {
  w: number;
  h: number;
  title: string;
  spec: ChartSpec;
  data: Record<string, CellValue>[];
  sourceNote: string;
  hiddenSeries: string[];
  focusX: string | null;
};

export type TableShapeProps = {
  w: number;
  h: number;
  title: string;
  columns: string[];
  rows: CellValue[][];
  highlightRow: number;
  sourceNote: string;
  sortBy: { column: number; dir: "asc" | "desc" } | null;
  selectedRows: number[];
};

export type ImageShapeProps = {
  w: number;
  h: number;
  title: string;
  src: string;
  alt: string;
  caption: string;
};

export type MapShapeProps = {
  w: number;
  h: number;
  title: string;
  markers: MapMarker[];
  center: { lat: number; lng: number } | null;
  zoom: number | null;
  style: MapNodeStyle;
  selectedMarker: number;
};

export type LogoShapeProps = {
  w: number;
  h: number;
  domain: string;
  name: string;
  note: string;
};

export type TimelineShapeProps = {
  w: number;
  h: number;
  title: string;
  events: DatedEvent[];
  sourceNote: string;
  selectedEventId: string | null;
};

export type CalendarShapeProps = {
  w: number;
  h: number;
  title: string;
  events: DatedEvent[];
  sourceNote: string;
  month: string;
  selectedDate: string | null;
};

export type TimelineShape = TLBaseShape<"kan-timeline", TimelineShapeProps>;
export type CalendarShape = TLBaseShape<"kan-calendar", CalendarShapeProps>;

const datedEventValidator = T.object({
  id: T.string,
  title: T.string,
  start: T.string,
  end: T.optional(T.string),
  description: T.optional(T.string),
  sourceNote: T.optional(T.string),
});

const datedShapeProps = {
  w: T.number,
  h: T.number,
  title: T.string,
  events: T.arrayOf(datedEventValidator),
  sourceNote: T.string,
};

export const timelineShapeProps = {
  ...datedShapeProps,
  selectedEventId: T.nullable(T.string),
};

export const calendarShapeProps = {
  ...datedShapeProps,
  month: T.string,
  selectedDate: T.nullable(T.string),
};

declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    "kan-markdown": MarkdownShapeProps;
    "kan-chart": ChartShapeProps;
    "kan-table": TableShapeProps;
    "kan-image": ImageShapeProps;
    "kan-map": MapShapeProps;
    "kan-logo": LogoShapeProps;
    "kan-timeline": TimelineShapeProps;
    "kan-calendar": CalendarShapeProps;
  }
}

export type MarkdownShape = TLBaseShape<"kan-markdown", MarkdownShapeProps>;
export type ChartShape = TLBaseShape<"kan-chart", ChartShapeProps>;
export type TableShape = TLBaseShape<"kan-table", TableShapeProps>;
export type ImageShape = TLBaseShape<"kan-image", ImageShapeProps>;
export type MapShape = TLBaseShape<"kan-map", MapShapeProps>;
export type LogoShape = TLBaseShape<"kan-logo", LogoShapeProps>;

export type KanShape =
  | MarkdownShape
  | ChartShape
  | TableShape
  | ImageShape
  | MapShape
  | LogoShape
  | TimelineShape
  | CalendarShape;

const cellValueValidator = T.or(
  T.or(T.string, T.number),
  T.nullable(T.boolean),
);

const chartSpecValidator = T.object({
  kind: T.literalEnum("bar", "line", "area", "pie"),
  x: T.string,
  series: T.arrayOf(
    T.object({
      key: T.string,
      label: T.optional(T.string),
    }),
  ),
  stacked: T.optional(T.boolean),
  yLabel: T.optional(T.string),
});

const mapMarkerValidator = T.object({
  lat: T.number,
  lng: T.number,
  label: T.string,
  note: T.optional(T.string),
});

const mapCenterValidator = T.object({ lat: T.number, lng: T.number });

export const markdownShapeProps = {
  w: T.number,
  h: T.number,
  title: T.string,
  body: T.string,
};

export const chartShapeProps = {
  w: T.number,
  h: T.number,
  title: T.string,
  spec: chartSpecValidator,
  data: T.arrayOf(T.dict(T.string, cellValueValidator)),
  sourceNote: T.string,
  hiddenSeries: T.arrayOf(T.string),
  focusX: T.nullable(T.string),
};

export const tableShapeProps = {
  w: T.number,
  h: T.number,
  title: T.string,
  columns: T.arrayOf(T.string),
  rows: T.arrayOf(T.arrayOf(cellValueValidator)),
  highlightRow: T.number,
  sourceNote: T.string,
  sortBy: T.nullable(
    T.object({
      column: T.number,
      dir: T.literalEnum("asc", "desc"),
    }),
  ),
  selectedRows: T.arrayOf(T.number),
};

export const imageShapeProps = {
  w: T.number,
  h: T.number,
  title: T.string,
  src: T.string,
  alt: T.string,
  caption: T.string,
};

export const mapShapeProps = {
  w: T.number,
  h: T.number,
  title: T.string,
  markers: T.arrayOf(mapMarkerValidator),
  center: T.nullable(mapCenterValidator),
  zoom: T.nullable(T.number),
  style: T.literalEnum("streets", "light", "dark", "satellite", "outdoor"),
  selectedMarker: T.number,
};

export const logoShapeProps = {
  w: T.number,
  h: T.number,
  domain: T.string,
  name: T.string,
  note: T.string,
};

export const kanShapeTypes = [
  "kan-markdown",
  "kan-chart",
  "kan-table",
  "kan-image",
  "kan-map",
  "kan-logo",
  "kan-timeline",
  "kan-calendar",
] as const;

export function isKanShape(shape: { type: string }): shape is KanShape {
  return (kanShapeTypes as readonly string[]).includes(shape.type);
}
