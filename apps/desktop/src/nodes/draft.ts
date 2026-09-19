import { toRichText, type TLGeoShape, type TLShapeId, type TLShapePartial } from "@tldraw/tlschema";

import { initialMonth } from "./dates";
import type { NodeDraft, NodeType, Provenance } from "./schema";
import type { KanShape } from "./shapes/types";

export const placementByType = {
  markdown: "beside",
  chart: "beside",
  table: "beside",
  image: "beside",
  map: "beside",
  logo: "overlap",
  timeline: "beside",
  geo: "beside",
  calendar: "beside",
} as const satisfies Record<NodeType, "beside" | "overlap">;

export function defaultSizeFor(type: NodeType) {
  switch (type) {
    case "markdown":
      return { w: 360, h: 240 };
    case "chart":
      return { w: 480, h: 320 };
    case "table":
      return { w: 480, h: 280 };
    case "image":
      return { w: 360, h: 300 };
    case "map":
      return { w: 480, h: 360 };
    case "logo":
      return { w: 160, h: 160 };
    case "timeline":
      return { w: 440, h: 440 };
    case "calendar":
      return { w: 520, h: 560 };
    case "geo":
      return { w: 200, h: 200 };
  }
}

export function draftToShapePartial(
  draft: NodeDraft,
  id: TLShapeId,
  position: { x: number; y: number },
  provenance?: Provenance,
): TLShapePartial<KanShape | TLGeoShape> {
  const size = defaultSizeFor(draft.type);
  const common = {
    id,
    x: position.x,
    y: position.y,
    meta: provenance ? { provenance } : {},
  };

  switch (draft.type) {
    case "markdown":
      return {
        ...common,
        type: "kan-markdown",
        props: { ...size, title: draft.title, body: draft.body },
      };
    case "chart":
      return {
        ...common,
        type: "kan-chart",
        props: {
          ...size,
          title: draft.title,
          spec: draft.spec,
          data: draft.data,
          sourceNote: draft.sourceNote ?? "",
          hiddenSeries: [],
          focusX: null,
        },
      };
    case "table":
      return {
        ...common,
        type: "kan-table",
        props: {
          ...size,
          w: Math.max(
            size.w,
            size.w + Math.max(0, draft.columns.length - 4) * 100,
          ),
          title: draft.title,
          columns: draft.columns,
          rows: draft.rows,
          highlightRow: draft.highlightRow ?? -1,
          sourceNote: draft.sourceNote ?? "",
          sortBy: null,
          selectedRows: [],
        },
      };
    case "image":
      return {
        ...common,
        type: "kan-image",
        props: {
          ...size,
          title: draft.title ?? "",
          src: draft.src,
          alt: draft.alt,
          caption: draft.caption ?? "",
        },
      };
    case "map":
      return {
        ...common,
        type: "kan-map",
        props: {
          ...size,
          title: draft.title,
          markers: draft.markers,
          center: draft.center ?? null,
          zoom: draft.zoom ?? null,
          style: draft.style ?? "aquarelle",
          selectedMarker: -1,
        },
      };
    case "timeline":
      return {
        ...common,
        type: "kan-timeline",
        props: {
          ...size,
          title: draft.title,
          events: draft.events,
          sourceNote: draft.sourceNote ?? "",
          selectedEventId: null,
        },
      };
    case "calendar":
      return {
        ...common,
        type: "kan-calendar",
        props: {
          ...size,
          title: draft.title,
          events: draft.events,
          sourceNote: draft.sourceNote ?? "",
          month: draft.month ?? initialMonth(draft.events),
          selectedDate: null,
        },
      };
    case "logo":
      return {
        ...common,
        type: "kan-logo",
        props: {
          ...size,
          domain: draft.domain,
          name: draft.name ?? "",
          note: draft.note ?? "",
        },
      };
    case "geo": {
      const w = draft.w ?? size.w;
      const h = draft.h ?? size.h;
      return {
        ...common,
        type: "geo",
        props: {
          geo: draft.geo,
          w,
          h,
          richText: toRichText(draft.text ?? ""),
        },
      };
    }
  }
}

export function shapeToSummary(shape: KanShape) {
  const common = {
    id: shape.id,
    type: shape.type.slice(4),
    x: shape.x,
    y: shape.y,
    w: shape.props.w,
    h: shape.props.h,
  };

  switch (shape.type) {
    case "kan-markdown":
      return {
        ...common,
        title: shape.props.title,
        body: shape.props.body.slice(0, 200),
      };
    case "kan-chart":
      return {
        ...common,
        title: shape.props.title,
        kind: shape.props.spec.kind,
        xField: shape.props.spec.x,
        series: shape.props.spec.series.map(({ key }) => key),
        rowCount: shape.props.data.length,
        hiddenSeries: shape.props.hiddenSeries,
        focusX: shape.props.focusX,
      };
    case "kan-table":
      return {
        ...common,
        title: shape.props.title,
        columns: shape.props.columns,
        rowCount: shape.props.rows.length,
        highlightRow: shape.props.highlightRow,
        selectedRows: shape.props.selectedRows,
        sortBy: shape.props.sortBy,
      };
    case "kan-image":
      return {
        ...common,
        title: shape.props.title,
        src: shape.props.src,
        alt: shape.props.alt,
      };
    case "kan-map":
      return {
        ...common,
        title: shape.props.title,
        markers: shape.props.markers.map(({ label, lat, lng }) => ({
          label,
          lat,
          lng,
        })),
        center: shape.props.center,
        zoom: shape.props.zoom,
        selectedMarker: shape.props.selectedMarker,
      };
    case "kan-timeline":
      return {
        ...common,
        title: shape.props.title,
        eventCount: shape.props.events.length,
        events: shape.props.events.map(({ id, title, start, end }) => ({
          id,
          title,
          start,
          end,
        })),
        selectedEventId: shape.props.selectedEventId,
      };
    case "kan-calendar":
      return {
        ...common,
        title: shape.props.title,
        eventCount: shape.props.events.length,
        events: shape.props.events.map(({ id, title, start, end }) => ({
          id,
          title,
          start,
          end,
        })),
        month: shape.props.month,
        selectedDate: shape.props.selectedDate,
      };
    case "kan-logo":
      return {
        ...common,
        domain: shape.props.domain,
        name: shape.props.name,
        note: shape.props.note,
      };
  }
}
