import {
  createShapeId,
  toRichText,
  type TLArrowBinding,
  type TLArrowShape,
  type TLFrameShape,
  type TLGeoShape,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
} from "@tldraw/tlschema";
import type { Editor } from "tldraw";

import { draftToShapePartial, placementByType, shapeToSummary } from "./draft";
import {
  addMermaidDiagramInput,
  addNodeInput,
  arrangeInput,
  connectNodesInput,
  focusNodesInput,
  getCanvasInput,
  groupNodesInput,
  removeNodesInput,
  updateNodeInput,
  type GroupNodesInput,
  type RemoveNodesInput,
  type UpdateNodeInput,
} from "./schema";
import { stripMermaidFence } from "@/lib/mermaid";
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
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

function isCollidableShape(shape: TLShape) {
  return shape.type !== "arrow";
}

function easeInOutQuart(t: number) {
  return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
}

const GROUP_PADDING = 28;
const GROUP_GAP = 20;

type GroupLayoutItem = { id: TLShapeId; w: number; h: number };
type GroupLayout = {
  x: number;
  y: number;
  w: number;
  h: number;
  positions: { id: TLShapeId; x: number; y: number }[];
};

function layoutGroup(items: GroupLayoutItem[], origin: { x: number; y: number }): GroupLayout {
  const columnCount = Math.ceil(Math.sqrt(items.length));
  const rowCount = Math.ceil(items.length / columnCount);
  const columnWidths = Array.from({ length: columnCount }, () => 0);
  const rowHeights = Array.from({ length: rowCount }, () => 0);

  items.forEach(({ w, h }, index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    columnWidths[column] = Math.max(columnWidths[column], Math.max(1, w));
    rowHeights[row] = Math.max(rowHeights[row], Math.max(1, h));
  });

  const xOffsets = columnWidths.map((_, index) =>
    columnWidths.slice(0, index).reduce((sum, width) => sum + width + GROUP_GAP, 0),
  );
  const yOffsets = rowHeights.map((_, index) =>
    rowHeights.slice(0, index).reduce((sum, height) => sum + height + GROUP_GAP, 0),
  );

  return {
    ...origin,
    w: GROUP_PADDING * 2 + columnWidths.reduce((sum, width) => sum + width, 0) + GROUP_GAP * (columnCount - 1),
    h: GROUP_PADDING * 2 + rowHeights.reduce((sum, height) => sum + height, 0) + GROUP_GAP * (rowCount - 1),
    positions: items.map(({ id }, index) => ({
      id,
      x: GROUP_PADDING + xOffsets[index % columnCount],
      y: GROUP_PADDING + yOffsets[Math.floor(index / columnCount)],
    })),
  };
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
    return full
      ? { ...summary, props: shape.props, meta: shape.meta }
      : summary;
  }
  const bounds = editor.getShapePageBounds(shape);
  const common = {
    id: shape.id,
    type: shape.type,
    x: bounds?.x ?? shape.x,
    y: bounds?.y ?? shape.y,
    w: bounds?.w ?? 0,
    h: bounds?.h ?? 0,
  };
  if (shape.type === "frame") {
    const frame = shape as TLFrameShape;
    return {
      ...common,
      type: "group",
      title: frame.props.name || "Group",
      children: editor.getSortedChildIdsForParent(frame.id),
      ...(full ? { props: frame.props, meta: frame.meta } : {}),
    };
  }
  const text = editor.getShapeUtil(shape).getText(shape);
  const summary = {
    ...common,
    ...(shape.type === "geo" ? { geo: (shape as TLGeoShape).props.geo } : {}),
    ...(text ? { text } : {}),
  };
  return full ? { ...summary, props: shape.props, meta: shape.meta } : summary;
}

function getConnections(editor: Editor) {
  return editor
    .getCurrentPageShapes()
    .filter((shape): shape is TLArrowShape => shape.type === "arrow")
    .flatMap((arrow) => {
      const bindings = editor.getBindingsFromShape<TLArrowBinding>(
        arrow,
        "arrow",
      );
      const start = bindings.find(
        (binding) => binding.props.terminal === "start",
      );
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

export function isGroupedFrame(shape: TLShape): shape is TLFrameShape {
  return shape.type === "frame" && (shape.meta.kanGroup === true || shape.props.name === "Group");
}

export function ungroupCanvasFrame(editor: Editor, frameId: TLShapeId) {
  if (editor.getIsReadonly()) throw new Error("Canvas is read-only");

  const frame = editor.getShape(frameId);
  if (!frame || !isGroupedFrame(frame)) {
    throw new Error(`Grouped frame not found: ${frameId}`);
  }
  if (editor.isShapeOrAncestorLocked(frame)) {
    throw new Error("Cannot ungroup a locked group");
  }

  const childIds = editor.getSortedChildIdsForParent(frame.id);
  editor.markHistoryStoppingPoint("ungroup nodes");
  editor.run(() => {
    editor.reparentShapes(childIds, frame.parentId, frame.index);
    editor.deleteShapes([frame.id]);
    editor.select(...childIds);
  });

  return { shapeIds: childIds };
}

function groupShapes(editor: Editor, shapeIds: string[]) {
  if (editor.getIsReadonly()) throw new Error("Canvas is read-only");

  const ids = [...new Set(shapeIds)] as TLShapeId[];
  if (ids.length < 2) throw new Error("At least two shapes are required to create a group");

  const currentPageId = editor.getCurrentPageId();
  const shapes = ids.map((id) => {
    const shape = editor.getShape(id);
    if (!shape) throw new Error(`Shape not found: ${id}`);
    if (editor.getAncestorPageId(shape) !== currentPageId) {
      throw new Error(`Shape is not on the current page: ${id}`);
    }
    const bounds = editor.getShapePageBounds(shape);
    if (!bounds) throw new Error(`Unable to read bounds: ${id}`);
    return { shape, bounds };
  });
  const groupableShapes = shapes.filter(({ shape }) => !editor.isShapeOrAncestorLocked(shape));
  if (groupableShapes.length < 2) {
    throw new Error("At least two unlocked shapes are required to create a group");
  }
  const groupableIds = groupableShapes.map(({ shape }) => shape.id);

  const minX = Math.min(...groupableShapes.map(({ bounds }) => bounds.x));
  const minY = Math.min(...groupableShapes.map(({ bounds }) => bounds.y));
  const maxX = Math.max(...groupableShapes.map(({ bounds }) => bounds.x + bounds.w));
  const maxY = Math.max(...groupableShapes.map(({ bounds }) => bounds.y + bounds.h));
  const origin = { x: minX - GROUP_PADDING, y: minY - GROUP_PADDING };
  const initialSize = {
    w: Math.max(1, maxX - minX + GROUP_PADDING * 2),
    h: Math.max(1, maxY - minY + GROUP_PADDING * 2),
  };
  const layout = layoutGroup(
    groupableShapes.map(({ shape, bounds }) => ({ id: shape.id, w: bounds.w, h: bounds.h })),
    origin,
  );
  const groupId = createShapeId();

  editor.markHistoryStoppingPoint("group nodes");
  editor.run(() => {
    editor.createShape<TLFrameShape>({
      id: groupId,
      type: "frame",
      parentId: currentPageId,
      x: origin.x,
      y: origin.y,
      meta: { kanGroup: true },
      props: {
        ...initialSize,
        name: "Group",
        color: "black",
      },
    });
    editor.reparentShapes(groupableIds, groupId);
  });

  editor.animateShapes(
    [
      {
        id: groupId,
        type: "frame",
        props: { w: layout.w, h: layout.h },
      },
      ...layout.positions.map(({ id, x, y }) => {
        const shape = editor.getShape(id);
        return shape ? { id, type: shape.type, x, y } : null;
      }),
    ],
    {
      animation: {
        duration: editor.options.animationMediumMs * 2,
        easing: easeInOutQuart,
      },
    },
  );
  editor.select(groupId);

  return { shapeId: groupId, memberShapeIds: groupableIds };
}

export function createCanvasTools(editor: Editor, assertActive?: () => void) {
  if (assertActive) {
    const original = editor;
    editor = new Proxy(original, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? (...args: unknown[]) => { assertActive(); return value.apply(target, args); } : value;
      },
    });
  }
  return {
    addNode(input: unknown) {
      const parsed = addNodeInput.parse(input);
      const id = createShapeId();
      const preview = draftToShapePartial(
        parsed.draft,
        id,
        { x: 0, y: 0 },
        parsed.provenance,
      );
      const props = preview.props as { w: number; h: number };
      let position: { x: number; y: number };

      if (parsed.at) {
        position = parsed.at;
      } else if (parsed.near) {
        const nearShapeId = parsed.near.shapeId as TLShapeId;
        const nearShape = editor.getShape(nearShapeId);
        if (!nearShape || !editor.getCurrentPageShapeIds().has(nearShapeId)) {
          throw new Error(`Shape not found on current page: ${parsed.near.shapeId}`);
        }
        const nearBounds = editor.getShapePageBounds(nearShape);
        if (!nearBounds) {
          throw new Error(`Shape not found on current page: ${parsed.near.shapeId}`);
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
            if (!isCollidableShape(shape) || shape.id === parsed.near?.shapeId) return false;
            const bounds = editor.getShapePageBounds(shape);
            return bounds ? intersects(right, bounds) : false;
          });
          position = overlaps
            ? { x: nearBounds.x, y: nearBounds.y + nearBounds.h + 40 }
            : { x: right.x, y: right.y };
        }
      } else {
        const viewport = editor.getViewportPageBounds();
        const count = editor.getCurrentPageShapes().filter(isCollidableShape).length;
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

    async addMermaidDiagram(input: unknown) {
      const parsed = addMermaidDiagramInput.parse(input);
      const before = new Set(editor.getCurrentPageShapeIds());
      const { createMermaidDiagram } = await import("@tldraw/mermaid");
      await createMermaidDiagram(editor, stripMermaidFence(parsed.source), {
        ...(parsed.at
          ? { blueprintRender: { position: parsed.at, centerOnPosition: false } }
          : {}),
      });

      const shapeIds = [...editor.getCurrentPageShapeIds()].filter((id) => !before.has(id));
      if (!shapeIds.length) throw new Error("Mermaid diagram did not create any shapes");

      if (parsed.provenance) {
        const updates: TLShapePartial[] = shapeIds.flatMap((shapeId) => {
          const shape = editor.getShape(shapeId);
          return shape
            ? [{ id: shape.id, type: shape.type, meta: { ...shape.meta, provenance: parsed.provenance } }]
            : [];
        });
        if (updates.length) editor.run(() => editor.updateShapes(updates));
      }

      const pageId = editor.getCurrentPageId();
      const topLevelIds = shapeIds.filter((shapeId) => editor.getShape(shapeId)?.parentId === pageId);
      editor.setSelectedShapes(topLevelIds.length ? topLevelIds : shapeIds);
      return { shapeIds };
    },

    updateNode(input: UpdateNodeInput) {
      const parsed = updateNodeInput.parse(input);
      const shape = editor.getShape(parsed.shapeId as TLShapeId);
      if (!shape) throw new Error(`Shape not found: ${parsed.shapeId}`);

      if (!isKanShape(shape)) {
        if (parsed.patch.type !== shape.type) {
          throw new Error(
            `Cannot apply ${parsed.patch.type} patch to ${shape.type} shape ${shape.id}`,
          );
        }
        if (shape.type !== "geo" || parsed.patch.type !== "geo") {
          throw new Error(`Shape ${parsed.shapeId} is not an editable normal box`);
        }
        const patch = parsed.patch;
        const props: Partial<TLGeoShape["props"]> = {
          ...(patch.color !== undefined ? { color: patch.color } : {}),
          ...(patch.w !== undefined ? { w: patch.w } : {}),
          ...(patch.h !== undefined ? { h: patch.h } : {}),
          ...(patch.text !== undefined ? { richText: toRichText(patch.text) } : {}),
        };
        const shapeUpdate: TLShapePartial<TLGeoShape> = {
          id: shape.id,
          type: "geo",
          ...(patch.x !== undefined ? { x: patch.x } : {}),
          ...(patch.y !== undefined ? { y: patch.y } : {}),
          props,
        };
        editor.run(() => editor.updateShape(shapeUpdate));
        return { shapeId: shape.id };
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
            ...(parsed.patch.title !== undefined
              ? { title: parsed.patch.title }
              : {}),
            ...(parsed.patch.body !== undefined
              ? { body: parsed.patch.body }
              : {}),
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
          const focusCandidate =
            parsed.patch.focusX !== undefined
              ? parsed.patch.focusX
              : current.props.focusX;
          const xValues = new Set(data.map((row) => String(row[spec.x] ?? "")));
          const focusX =
            focusCandidate !== null && xValues.has(focusCandidate)
              ? focusCandidate
              : null;
          shapeUpdate.props = {
            ...(w !== undefined ? { w } : {}),
            ...(h !== undefined ? { h } : {}),
            ...(parsed.patch.title !== undefined
              ? { title: parsed.patch.title }
              : {}),
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
          const highlightCandidate =
            parsed.patch.highlightRow !== undefined
              ? parsed.patch.highlightRow
              : current.props.highlightRow;
          const highlightRow =
            highlightCandidate < rows.length ? highlightCandidate : -1;
          const sortCandidate =
            parsed.patch.sortBy !== undefined
              ? parsed.patch.sortBy
              : current.props.sortBy;
          const sortBy =
            sortCandidate && sortCandidate.column < columns.length
              ? sortCandidate
              : null;
          shapeUpdate.props = {
            ...(w !== undefined ? { w } : {}),
            ...(h !== undefined ? { h } : {}),
            ...(parsed.patch.title !== undefined
              ? { title: parsed.patch.title }
              : {}),
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
            ...(parsed.patch.title !== undefined
              ? { title: parsed.patch.title }
              : {}),
            ...(parsed.patch.src !== undefined
              ? { src: parsed.patch.src }
              : {}),
            ...(parsed.patch.alt !== undefined
              ? { alt: parsed.patch.alt }
              : {}),
            ...(parsed.patch.caption !== undefined
              ? { caption: parsed.patch.caption }
              : {}),
          };
          break;
        }
        case "map": {
          const current = shape as MapShape;
          const markers = parsed.patch.markers ?? current.props.markers;
          const selectedCandidate =
            parsed.patch.selectedMarker !== undefined
              ? parsed.patch.selectedMarker
              : current.props.selectedMarker;
          const selectedMarker =
            selectedCandidate >= 0 && selectedCandidate < markers.length
              ? selectedCandidate
              : -1;
          shapeUpdate.props = {
            ...(w !== undefined ? { w } : {}),
            ...(h !== undefined ? { h } : {}),
            ...(parsed.patch.title !== undefined
              ? { title: parsed.patch.title }
              : {}),
            ...(parsed.patch.markers !== undefined ? { markers } : {}),
            ...(parsed.patch.center !== undefined
              ? { center: parsed.patch.center }
              : {}),
            ...(parsed.patch.zoom !== undefined
              ? { zoom: parsed.patch.zoom }
              : {}),
            ...(parsed.patch.style !== undefined
              ? { style: parsed.patch.style }
              : {}),
            selectedMarker,
          };
          break;
        }
        case "timeline": {
          const current = shape as TimelineShape;
          const { type: _type, x: _x, y: _y, ...props } = parsed.patch;
          const events = props.events ?? current.props.events;
          const candidate =
            props.selectedEventId !== undefined
              ? props.selectedEventId
              : current.props.selectedEventId;
          shapeUpdate.props = {
            ...props,
            selectedEventId: events.some(({ id }) => id === candidate)
              ? candidate
              : null,
          };
          break;
        }
        case "calendar": {
          const current = shape as CalendarShape;
          const { type: _type, x: _x, y: _y, ...props } = parsed.patch;
          const month =
            props.selectedDate?.slice(0, 7) ??
            props.month ??
            current.props.month;
          const candidate =
            props.selectedDate !== undefined
              ? props.selectedDate
              : current.props.selectedDate;
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
            ...(parsed.patch.domain !== undefined
              ? { domain: parsed.patch.domain }
              : {}),
            ...(parsed.patch.name !== undefined
              ? { name: parsed.patch.name }
              : {}),
            ...(parsed.patch.note !== undefined
              ? { note: parsed.patch.note }
              : {}),
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
        for (const binding of editor.getBindingsToShape<TLArrowBinding>(
          shape,
          "arrow",
        )) {
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
      if (!fromBounds || !toBounds)
        throw new Error("Unable to read node bounds");
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
              x:
                toBounds.x + toBounds.w / 2 - (fromBounds.x + fromBounds.w / 2),
              y:
                toBounds.y + toBounds.h / 2 - (fromBounds.y + fromBounds.h / 2),
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

    groupNodes(input: GroupNodesInput) {
      const parsed = groupNodesInput.parse(input);
      return groupShapes(editor, parsed.shapeIds);
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
        const xPositions = columnWidths.map(
          (_, index) =>
            anchorX +
            columnWidths
              .slice(0, index)
              .reduce((sum, width) => sum + width + gap, 0),
        );
        const yPositions = rowHeights.map(
          (_, index) =>
            anchorY +
            rowHeights
              .slice(0, index)
              .reduce((sum, height) => sum + height + gap, 0),
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

    focusNodes(input: unknown) {
      const parsed = focusNodesInput.parse(input);
      const currentPageShapeIds = editor.getCurrentPageShapeIds();
      const shapes = parsed.shapeIds.map((id) => {
        const shapeId = id as TLShapeId;
        if (!currentPageShapeIds.has(shapeId)) {
          throw new Error(`Shape not found on current page: ${id}`);
        }
        const shape = editor.getShape(shapeId);
        if (!shape) throw new Error(`Shape not found on current page: ${id}`);
        const bounds = editor.getShapePageBounds(shape);
        if (!bounds) throw new Error(`Unable to read bounds: ${id}`);
        return bounds;
      });
      const bounds = shapes.reduce(
        (combined, current) => ({
          x: Math.min(combined.x, current.x),
          y: Math.min(combined.y, current.y),
          w: Math.max(combined.x + combined.w, current.x + current.w) - Math.min(combined.x, current.x),
          h: Math.max(combined.y + combined.h, current.y + current.h) - Math.min(combined.y, current.y),
        }),
        { x: shapes[0].x, y: shapes[0].y, w: shapes[0].w, h: shapes[0].h },
      );
      editor.zoomToBounds(bounds, {
        animation: {
          duration: editor.options.animationMediumMs * 5,
          easing: easeInOutQuart,
        },
      });
      return { shapeIds: parsed.shapeIds, bounds };
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
