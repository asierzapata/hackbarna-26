import {
  createShapeId,
  toRichText,
  type Editor,
  type TLArrowBinding,
  type TLArrowShape,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
} from "tldraw";

import {
  draftToShapePartial,
  placementByType,
  shapeToSummary,
} from "./draft";
import {
  addNodeInput,
  arrangeInput,
  connectNodesInput,
  getCanvasInput,
  removeNodesInput,
  updateNodeInput,
  type RemoveNodesInput,
  type UpdateNodeInput,
} from "./schema";
import {
  isKanShape,
  type ChartShape,
  type KanShape,
  type MapShape,
  type TableShape,
  type TimelineShape,
  type CalendarShape,
} from "./shapes/types";

type Bounds = { x: number; y: number; w: number; h: number };

function intersects(a: Bounds, b: Bounds) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function easeInOutQuart(t: number) {
  return t < 0.5
    ? 8 * t * t * t * t
    : 1 - Math.pow(-2 * t + 2, 4) / 2;
}

function textFromRichText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if ("text" in value && typeof value.text === "string") return value.text;
  if ("content" in value && Array.isArray(value.content)) {
    return value.content.map(textFromRichText).filter(Boolean).join(" ");
  }
  return "";
}

function summarizeShape(editor: Editor, shape: TLShape, full = false) {
  if (isKanShape(shape)) {
    const summary = shapeToSummary(shape);
    return full ? { ...summary, props: shape.props, meta: shape.meta } : summary;
  }
  const bounds = editor.getShapePageBounds(shape);
  const text = editor.getShapeUtil(shape).getText(shape);
  return {
    id: shape.id,
    type: shape.type,
    x: bounds?.x ?? shape.x,
    y: bounds?.y ?? shape.y,
    w: bounds?.w ?? 0,
    h: bounds?.h ?? 0,
    ...(text ? { text } : {}),
  };
}

function getConnections(editor: Editor) {
  return editor
    .getCurrentPageShapes()
    .filter((shape): shape is TLArrowShape => shape.type === "arrow")
    .flatMap((arrow) => {
      const bindings = editor.getBindingsFromShape<TLArrowBinding>(arrow, "arrow");
      const start = bindings.find((binding) => binding.props.terminal === "start");
      const end = bindings.find((binding) => binding.props.terminal === "end");
      if (!start || !end) return [];
      return [
        {
          id: arrow.id,
          from: start.toId,
          to: end.toId,
          label: textFromRichText(arrow.props.richText),
        },
      ];
    });
}

export function createCanvasTools(editor: Editor) {
  return {
    addNode(input: unknown) {
      const parsed = addNodeInput.parse(input);
      const id = createShapeId();
      const preview = draftToShapePartial(parsed.draft, id, { x: 0, y: 0 }, parsed.provenance);
      const props = preview.props as { w: number; h: number };
      let position: { x: number; y: number };

      if (parsed.at) {
        position = parsed.at;
      } else if (parsed.near) {
        const nearBounds = editor.getShapePageBounds(parsed.near.shapeId as TLShapeId);
        if (!nearBounds) {
          throw new Error(`Shape not found: ${parsed.near.shapeId}`);
        }
        if (placementByType[parsed.draft.type] === "overlap") {
          position = {
            x: nearBounds.x + nearBounds.w - props.w / 2,
            y: nearBounds.y - props.h / 2,
          };
        } else {
          const right = {
            x: nearBounds.x + nearBounds.w + 40,
            y: nearBounds.y,
            w: props.w,
            h: props.h,
          };
          const overlaps = editor.getCurrentPageShapes().some((shape) => {
            if (!isKanShape(shape) || shape.id === parsed.near?.shapeId) return false;
            const bounds = editor.getShapePageBounds(shape);
            return bounds ? intersects(right, bounds) : false;
          });
          position = overlaps
            ? { x: nearBounds.x, y: nearBounds.y + nearBounds.h + 40 }
            : { x: right.x, y: right.y };
        }
      } else {
        const viewport = editor.getViewportPageBounds();
        const count = editor.getCurrentPageShapes().filter(isKanShape).length;
        const nudge = (count % 8) * 24;
        position = {
          x: viewport.x + viewport.w / 2 - props.w / 2 + nudge,
          y: viewport.y + viewport.h / 2 - props.h / 2 + nudge,
        };
      }

      editor.run(() => {
        editor.createShape(
          draftToShapePartial(parsed.draft, id, position, parsed.provenance),
        );
      });

      const bounds = editor.getShapePageBounds(id);
      if (bounds) {
        editor.centerOnPoint(
          { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
          {
            animation: {
              duration: editor.options.animationMediumMs * 5,
              easing: easeInOutQuart,
            },
          },
        );
      }

      return { shapeId: id };
    },

    updateNode(input: UpdateNodeInput) {
      const parsed = updateNodeInput.parse(input);
      const shape = editor.getShape(parsed.shapeId as TLShapeId);
      if (!shape) throw new Error(`Shape not found: ${parsed.shapeId}`);
      if (!isKanShape(shape)) {
        throw new Error(`Shape ${parsed.shapeId} is not a Kan node`);
      }
      const actualType = shape.type.slice(4);
      if (parsed.patch.type !== actualType) {
        throw new Error(
          `Cannot apply ${parsed.patch.type} patch to ${actualType} node ${shape.id}`,
        );
      }

      const { x, y, w, h } = parsed.patch;
      const shapeUpdate: TLShapePartial<KanShape> = {
        id: shape.id,
        type: shape.type,
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
      } as TLShapePartial<KanShape>;

      switch (parsed.patch.type) {
        case "markdown": {
          shapeUpdate.props = {
            ...(w !== undefined ? { w } : {}),
            ...(h !== undefined ? { h } : {}),
            ...(parsed.patch.title !== undefined ? { title: parsed.patch.title } : {}),
            ...(parsed.patch.body !== undefined ? { body: parsed.patch.body } : {}),
          };
          break;
        }
        case "chart": {
          const current = shape as ChartShape;
          const spec = parsed.patch.spec ?? current.props.spec;
          const data = parsed.patch.data ?? current.props.data;
          const seriesKeys = new Set(spec.series.map(({ key }) => key));
          const hiddenSeries = (
            parsed.patch.hiddenSeries ?? current.props.hiddenSeries
          ).filter((key) => seriesKeys.has(key));
          const focusCandidate = parsed.patch.focusX !== undefined
            ? parsed.patch.focusX
            : current.props.focusX;
          const xValues = new Set(data.map((row) => String(row[spec.x] ?? "")));
          const focusX = focusCandidate !== null && xValues.has(focusCandidate)
            ? focusCandidate
            : null;
          shapeUpdate.props = {
            ...(w !== undefined ? { w } : {}),
            ...(h !== undefined ? { h } : {}),
            ...(parsed.patch.title !== undefined ? { title: parsed.patch.title } : {}),
            ...(parsed.patch.spec !== undefined ? { spec } : {}),
            ...(parsed.patch.data !== undefined ? { data } : {}),
            ...(parsed.patch.sourceNote !== undefined
              ? { sourceNote: parsed.patch.sourceNote }
              : {}),
            hiddenSeries,
            focusX,
          };
          break;
        }
        case "table": {
          const current = shape as TableShape;
          const rows = parsed.patch.rows ?? current.props.rows;
          const columns = parsed.patch.columns ?? current.props.columns;
          const selectedRows = (
            parsed.patch.selectedRows ?? current.props.selectedRows
          ).filter((index) => index < rows.length);
          const highlightCandidate = parsed.patch.highlightRow !== undefined
            ? parsed.patch.highlightRow
            : current.props.highlightRow;
          const highlightRow = highlightCandidate < rows.length
            ? highlightCandidate
            : -1;
          const sortCandidate = parsed.patch.sortBy !== undefined
            ? parsed.patch.sortBy
            : current.props.sortBy;
          const sortBy = sortCandidate && sortCandidate.column < columns.length
            ? sortCandidate
            : null;
          shapeUpdate.props = {
            ...(w !== undefined ? { w } : {}),
            ...(h !== undefined ? { h } : {}),
            ...(parsed.patch.title !== undefined ? { title: parsed.patch.title } : {}),
            ...(parsed.patch.columns !== undefined ? { columns } : {}),
            ...(parsed.patch.rows !== undefined ? { rows } : {}),
            ...(parsed.patch.sourceNote !== undefined
              ? { sourceNote: parsed.patch.sourceNote }
              : {}),
            selectedRows,
            highlightRow,
            sortBy,
          };
          break;
        }
        case "image": {
          shapeUpdate.props = {
            ...(w !== undefined ? { w } : {}),
            ...(h !== undefined ? { h } : {}),
            ...(parsed.patch.title !== undefined ? { title: parsed.patch.title } : {}),
            ...(parsed.patch.src !== undefined ? { src: parsed.patch.src } : {}),
            ...(parsed.patch.alt !== undefined ? { alt: parsed.patch.alt } : {}),
            ...(parsed.patch.caption !== undefined
              ? { caption: parsed.patch.caption }
              : {}),
          };
          break;
        }
        case "map": {
          const current = shape as MapShape;
          const markers = parsed.patch.markers ?? current.props.markers;
          const selectedCandidate = parsed.patch.selectedMarker !== undefined
            ? parsed.patch.selectedMarker
            : current.props.selectedMarker;
          const selectedMarker = selectedCandidate >= 0 && selectedCandidate < markers.length
            ? selectedCandidate
            : -1;
          shapeUpdate.props = {
            ...(w !== undefined ? { w } : {}),
            ...(h !== undefined ? { h } : {}),
            ...(parsed.patch.title !== undefined ? { title: parsed.patch.title } : {}),
            ...(parsed.patch.markers !== undefined ? { markers } : {}),
            ...(parsed.patch.center !== undefined ? { center: parsed.patch.center } : {}),
            ...(parsed.patch.zoom !== undefined ? { zoom: parsed.patch.zoom } : {}),
            ...(parsed.patch.style !== undefined ? { style: parsed.patch.style } : {}),
            selectedMarker,
          };
          break;
        }
        case "timeline": {
          const current = shape as TimelineShape;
          const { type: _type, x: _x, y: _y, ...props } = parsed.patch;
          const events = props.events ?? current.props.events;
          const candidate = props.selectedEventId !== undefined
            ? props.selectedEventId : current.props.selectedEventId;
          shapeUpdate.props = {
            ...props,
            selectedEventId: events.some(({ id }) => id === candidate) ? candidate : null,
          };
          break;
        }
        case "calendar": {
          const current = shape as CalendarShape;
          const { type: _type, x: _x, y: _y, ...props } = parsed.patch;
          const month = props.selectedDate?.slice(0, 7) ?? props.month ?? current.props.month;
          const candidate = props.selectedDate !== undefined
            ? props.selectedDate : current.props.selectedDate;
          shapeUpdate.props = {
            ...props,
            month,
            selectedDate: candidate?.startsWith(`${month}-`) ? candidate : null,
          };
          break;
        }
        case "logo": {
          shapeUpdate.props = {
            ...(w !== undefined ? { w } : {}),
            ...(h !== undefined ? { h } : {}),
            ...(parsed.patch.domain !== undefined ? { domain: parsed.patch.domain } : {}),
            ...(parsed.patch.name !== undefined ? { name: parsed.patch.name } : {}),
            ...(parsed.patch.note !== undefined ? { note: parsed.patch.note } : {}),
          };
          break;
        }
      }

      editor.run(() => editor.updateShape(shapeUpdate));
      return { shapeId: shape.id };
    },

    removeNodes(input: RemoveNodesInput) {
      const parsed = removeNodesInput.parse(input);
      const removed = new Set<TLShapeId>();
      for (const id of parsed.shapeIds) {
        const shape = editor.getShape(id as TLShapeId);
        if (!shape) continue;
        removed.add(shape.id);
        for (const binding of editor.getBindingsToShape<TLArrowBinding>(shape, "arrow")) {
          const arrow = editor.getShape(binding.fromId);
          if (arrow?.type === "arrow") removed.add(arrow.id);
        }
      }
      editor.run(() => editor.deleteShapes([...removed]));
      return { removed: [...removed] };
    },

    connectNodes(input: unknown) {
      const parsed = connectNodesInput.parse(input);
      const from = editor.getShape(parsed.from as TLShapeId);
      const to = editor.getShape(parsed.to as TLShapeId);
      if (!from) throw new Error(`Shape not found: ${parsed.from}`);
      if (!to) throw new Error(`Shape not found: ${parsed.to}`);
      const fromBounds = editor.getShapePageBounds(from);
      const toBounds = editor.getShapePageBounds(to);
      if (!fromBounds || !toBounds) throw new Error("Unable to read node bounds");
      const id = createShapeId();

      editor.run(() => {
        editor.createShape<TLArrowShape>({
          id,
          type: "arrow",
          x: fromBounds.x + fromBounds.w / 2,
          y: fromBounds.y + fromBounds.h / 2,
          props: {
            start: { x: 0, y: 0 },
            end: {
              x: toBounds.x + toBounds.w / 2 - (fromBounds.x + fromBounds.w / 2),
              y: toBounds.y + toBounds.h / 2 - (fromBounds.y + fromBounds.h / 2),
            },
            richText: toRichText(parsed.label ?? ""),
          },
        });
        editor.createBindings<TLArrowBinding>([
          {
            type: "arrow",
            fromId: id,
            toId: from.id,
            props: {
              terminal: "start",
              normalizedAnchor: { x: 0.5, y: 0.5 },
              isExact: false,
              isPrecise: false,
              snap: "none",
            },
          },
          {
            type: "arrow",
            fromId: id,
            toId: to.id,
            props: {
              terminal: "end",
              normalizedAnchor: { x: 0.5, y: 0.5 },
              isExact: false,
              isPrecise: false,
              snap: "none",
            },
          },
        ]);
      });
      return { shapeId: id };
    },

    arrange(input: unknown) {
      const parsed = arrangeInput.parse(input);
      const gap = parsed.gap ?? 40;
      const shapes = parsed.shapeIds.map((id) => {
        const shape = editor.getShape(id as TLShapeId);
        if (!shape) throw new Error(`Shape not found: ${id}`);
        const bounds = editor.getShapePageBounds(shape);
        if (!bounds) throw new Error(`Unable to read bounds: ${id}`);
        return { shape, bounds };
      });
      const anchorX = Math.min(...shapes.map(({ bounds }) => bounds.x));
      const anchorY = Math.min(...shapes.map(({ bounds }) => bounds.y));
      const updates: TLShapePartial[] = [];

      if (parsed.layout === "row") {
        let x = anchorX;
        for (const { shape, bounds } of shapes) {
          updates.push({ id: shape.id, type: shape.type, x, y: anchorY });
          x += bounds.w + gap;
        }
      } else if (parsed.layout === "column") {
        let y = anchorY;
        for (const { shape, bounds } of shapes) {
          updates.push({ id: shape.id, type: shape.type, x: anchorX, y });
          y += bounds.h + gap;
        }
      } else {
        const columnCount = Math.ceil(Math.sqrt(shapes.length));
        const columnWidths = Array.from({ length: columnCount }, () => 0);
        const rowCount = Math.ceil(shapes.length / columnCount);
        const rowHeights = Array.from({ length: rowCount }, () => 0);
        shapes.forEach(({ bounds }, index) => {
          const column = index % columnCount;
          const row = Math.floor(index / columnCount);
          columnWidths[column] = Math.max(columnWidths[column], bounds.w);
          rowHeights[row] = Math.max(rowHeights[row], bounds.h);
        });
        const xPositions = columnWidths.map((_, index) =>
          anchorX + columnWidths.slice(0, index).reduce((sum, width) => sum + width + gap, 0),
        );
        const yPositions = rowHeights.map((_, index) =>
          anchorY + rowHeights.slice(0, index).reduce((sum, height) => sum + height + gap, 0),
        );
        shapes.forEach(({ shape }, index) => {
          updates.push({
            id: shape.id,
            type: shape.type,
            x: xPositions[index % columnCount],
            y: yPositions[Math.floor(index / columnCount)],
          });
        });
      }

      editor.run(() => editor.updateShapes(updates));
      return { shapeIds: parsed.shapeIds };
    },

    getCanvas(input: unknown = {}) {
      const parsed = getCanvasInput.parse(input);
      const allShapes = editor.getCurrentPageShapes();
      if (parsed.scope === "summary") {
        const nodes = allShapes.filter(isKanShape).map(shapeToSummary);
        const others = allShapes
          .filter((shape) => shape.type !== "arrow" && !isKanShape(shape))
          .map((shape) => summarizeShape(editor, shape));
        const byType = nodes.reduce<Record<string, number>>((counts, node) => {
          counts[node.type] = (counts[node.type] ?? 0) + 1;
          return counts;
        }, {});
        return {
          counts: { byType },
          nodes,
          others,
          connections: getConnections(editor),
        };
      }

      let shapes: TLShape[];
      if (parsed.shapeIds) {
        shapes = parsed.shapeIds
          .map((id) => editor.getShape(id as TLShapeId))
          .filter((shape): shape is TLShape => Boolean(shape));
      } else if (parsed.scope === "selection") {
        shapes = editor
          .getSelectedShapeIds()
          .map((id) => editor.getShape(id))
          .filter((shape): shape is TLShape => Boolean(shape));
      } else if (parsed.scope === "viewport") {
        const viewport = editor.getViewportPageBounds();
        shapes = allShapes.filter((shape) => {
          const bounds = editor.getShapePageBounds(shape);
          return bounds ? intersects(viewport, bounds) : false;
        });
      } else {
        shapes = allShapes;
      }

      return {
        shapes: shapes.map((shape) =>
          summarizeShape(editor, shape, parsed.scope === "full"),
        ),
        connections: getConnections(editor),
      };
    },
  };
}

export type CanvasTools = ReturnType<typeof createCanvasTools>;
