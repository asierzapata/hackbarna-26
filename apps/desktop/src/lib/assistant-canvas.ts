import { createShapeId, toRichText, type TLArrowBinding, type TLShape, type TLShapeId, type TLShapePartial } from "@tldraw/tlschema";
import type { Editor } from "tldraw";
import { diagramPlacement, KAN_NODE_HEIGHT, KAN_NODE_WIDTH, planDiagram } from "@kan/nodes";
import { MutationSchema, type Mutation } from "@kan/protocol";
import { createCanvasTools } from "@/nodes/tools";
import { draftToShapePartial, placementByType } from "@/nodes/draft";

type Bounds = { x: number; y: number; w: number; h: number };

function easeInOutQuart(t: number) {
  return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
}

function focusCreatedShapes(editor: Editor, shapeIds: string[]) {
  if (!shapeIds.length || typeof editor.getShape !== "function" || typeof editor.getShapePageBounds !== "function") return;
  const bounds = shapeIds.flatMap((id) => {
    const shape = editor.getShape(id as TLShapeId);
    const value = shape ? editor.getShapePageBounds(shape) : undefined;
    return value ? [{ x: value.x, y: value.y, w: value.w, h: value.h }] : [];
  });
  if (!bounds.length) return;
  const combined = bounds.reduce<Bounds>((current, value) => ({
    x: Math.min(current.x, value.x),
    y: Math.min(current.y, value.y),
    w: Math.max(current.x + current.w, value.x + value.w) - Math.min(current.x, value.x),
    h: Math.max(current.y + current.h, value.y + value.h) - Math.min(current.y, value.y),
  }), bounds[0]);
  const animation = {
    duration: (editor.options?.animationMediumMs ?? 100) * 5,
    easing: easeInOutQuart,
  };
  if (bounds.length === 1) {
    editor.centerOnPoint?.({ x: combined.x + combined.w / 2, y: combined.y + combined.h / 2 }, { animation });
  } else {
    editor.zoomToBounds?.(combined, { animation });
  }
}

export function assistantCanvasRecords(editor: Editor | null) {
  if (!editor) return [];
  return Object.values(editor.getSnapshot().document.store).filter((record) => record.typeName === "shape");
}

export function applyAssistantOperations(editor: Editor, input: Mutation[], provenance: Record<string, string>): string[] {
  const operations = input.map((operation) => MutationSchema.parse(operation));
  if (editor.getIsReadonly?.()) throw new Error("Canvas is read-only");
  const puts: TLShapePartial[] = [];
  const diagramBindings: Parameters<Editor["createBindings"]>[0] = [];
  const bindings: Array<{ fromId: TLShapeId; toId: TLShapeId; terminal: "start" | "end" }> = [];
  const current = new Map(assistantCanvasRecords(editor).map((shape) => [shape.id, shape as TLShape]));
  const touched = new Set<string>();
  const created = new Set<string>();
  const groupRequests: string[][] = [];
  const get = (id: string) => {
    const shape = (puts.slice().reverse().find(shape => shape.id === id) ?? current.get(id as TLShapeId)) as TLShape | undefined;
    if (!shape) throw new Error("A referenced canvas item no longer exists");
    if (shape.isLocked) throw new Error("Unlock the referenced item before changing it");
    return shape;
  };
  const topLevel = (shape: TLShape) => {
    if (!shape.parentId.startsWith("page:") || shape.rotation !== 0) throw new Error("This operation requires unrotated top-level items");
  };
  for (const [index, operation] of operations.entries()) {
    if (operation.type === "diagram") {
      const { type: _type, ...graph } = operation;
      const near = operation.nearShapeId ? get(operation.nearShapeId) : undefined;
      if (near) topLevel(near);
      const pageId = near?.parentId ?? editor.getCurrentPageId();
      const viewport = editor.getViewportPageBounds();
      const origin = diagramPlacement([...current.values(), ...puts], pageId, { x: viewport.x + 80, y: viewport.y + 80 });
      const ids = new Map<string, string>();
      const plan = planDiagram(graph, { id: key => { if (!ids.has(key)) ids.set(key, `${provenance.entryId}-${index}-${ids.size}`); return ids.get(key)!; }, pageId, origin, provenance });
      if (plan.shapes.some(shape => current.has(shape.id) || puts.some(put => put.id === shape.id))) throw new Error("That canvas action was already applied");
      puts.push(...plan.shapes);
      diagramBindings.push(...plan.bindings);
      plan.shapes.forEach(shape => {
        touched.add(shape.id);
        if (shape.type !== "arrow") created.add(shape.id);
      });
    } else if (operation.type === "add") {
      const id = (operation.shapeId ?? createShapeId(`${provenance.entryId}-${index}`)) as TLShapeId;
      if (current.has(id) || puts.some(shape => shape.id === id)) throw new Error("That canvas action was already applied");
      const near = operation.nearShapeId ? get(operation.nearShapeId) : undefined;
      if (near) topLevel(near);
      const viewport = editor.getViewportPageBounds();
      const origin = diagramPlacement([...current.values(), ...puts], near?.parentId ?? editor.getCurrentPageId(), { x: viewport.x + 80, y: viewport.y + 80 });
      const richDraft = operation.draft.type === "calendar" || operation.draft.type === "map" || operation.draft.type === "table" || operation.draft.type === "logo" ? operation.draft : undefined;
      const preview = richDraft ? draftToShapePartial(richDraft, id, { x: 0, y: 0 }) : undefined;
      const size = (preview?.props ?? { w: KAN_NODE_WIDTH, h: KAN_NODE_HEIGHT }) as { w: number; h: number };
      const nearBounds = near ? editor.getShapePageBounds(near) : undefined;
      const overlapBounds = nearBounds && richDraft && placementByType[richDraft.type] === "overlap" ? nearBounds : undefined;
      const position = {
        x: operation.x ?? (overlapBounds ? overlapBounds.x + overlapBounds.w - size.w / 2 : origin.x),
        y: operation.y ?? (overlapBounds ? overlapBounds.y - size.h / 2 : near?.y ?? origin.y),
      };
      const shape: TLShapePartial = preview
        ? { ...preview, ...position, parentId: near?.parentId ?? editor.getCurrentPageId(), meta: { provenance } }
        : { id, type: "kan-node", parentId: near?.parentId ?? editor.getCurrentPageId(), ...position, props: { w: KAN_NODE_WIDTH, h: KAN_NODE_HEIGHT, draft: operation.draft }, meta: { provenance } };
      puts.push(shape);
      touched.add(id);
      created.add(id);
    } else if (operation.type === "update") {
      const shape = get(operation.shapeId);
      if (shape.type === "kan-calendar" && operation.draft.type === "calendar") {
        const draft = operation.draft;
        const month = draft.selectedDate?.slice(0, 7) ?? draft.month ?? shape.props.month;
        const selectedDate = draft.selectedDate === undefined ? shape.props.selectedDate : draft.selectedDate;
        puts.push({ ...shape, props: { ...shape.props, title: draft.title, events: draft.events, sourceNote: draft.sourceNote ?? "", month, selectedDate: selectedDate?.startsWith(`${month}-`) ? selectedDate : null }, meta: { ...shape.meta, provenance } });
      } else if (shape.type === "kan-map" && operation.draft.type === "map") {
        const next = draftToShapePartial(operation.draft, shape.id, { x: shape.x, y: shape.y });
        puts.push({ ...shape, ...next, props: { ...shape.props, ...next.props }, meta: { ...shape.meta, provenance } } as TLShapePartial);
      } else if (shape.type === "kan-table" && operation.draft.type === "table") {
        const next = draftToShapePartial(operation.draft, shape.id, { x: shape.x, y: shape.y });
        puts.push({ ...shape, ...next, props: { ...shape.props, ...next.props }, meta: { ...shape.meta, provenance } } as TLShapePartial);
      } else if (shape.type === "kan-logo" && operation.draft.type === "logo") {
        const next = draftToShapePartial(operation.draft, shape.id, { x: shape.x, y: shape.y });
        puts.push({ ...shape, ...next, props: { ...shape.props, ...next.props }, meta: { ...shape.meta, provenance } } as TLShapePartial);
      } else {
        if (shape.type !== "kan-node") throw new Error("Only shared Kan cards, maps, tables, logos, or rich calendars can be updated by this action");
        puts.push({ ...shape, props: { ...shape.props, draft: operation.draft }, meta: { ...shape.meta, provenance } } as TLShapePartial);
      }
      touched.add(shape.id);
    } else if (operation.type === "group") {
      const shapeIds = [...new Set(operation.shapeIds)];
      shapeIds.forEach((id) => get(id));
      groupRequests.push(shapeIds);
      shapeIds.forEach((id) => touched.add(id));
    } else if (operation.type === "style" || operation.type === "label") {
      const shape = get(operation.shapeId);
      if (shape.type !== "geo") throw new Error("Only native geometric shapes support color or label changes");
      const patch = operation.type === "style" ? { color: operation.color } : { richText: toRichText(operation.text) };
      puts.push({ ...shape, props: { ...shape.props, ...patch }, meta: { ...shape.meta, provenance } });
      touched.add(shape.id);
    } else if (operation.type === "connect") {
      const from = get(operation.from), to = get(operation.to);
      topLevel(from); topLevel(to);
      if (from.parentId !== to.parentId) throw new Error("Connected items must be on the same page");
      const a = editor.getShapePageBounds(from), b = editor.getShapePageBounds(to);
      if (!a || !b) throw new Error("Could not read item bounds");
      const id = createShapeId(`${provenance.entryId}-${index}`);
      puts.push({ id, type: "arrow", parentId: from.parentId, x: a.center.x, y: a.center.y, props: { start: { x: 0, y: 0 }, end: { x: b.center.x - a.center.x, y: b.center.y - a.center.y }, richText: toRichText(operation.label ?? "") }, meta: { provenance } });
      bindings.push({ fromId: id, toId: from.id, terminal: "start" }, { fromId: id, toId: to.id, terminal: "end" });
      touched.add(id);
    } else {
      const shapes = operation.shapeIds.map(get);
      for (const shape of shapes) topLevel(shape);
      if (shapes.some((shape) => shape.parentId !== shapes[0].parentId)) throw new Error("Arranged items must share a page");
      const x = Math.min(...shapes.map((shape) => shape.x)), y = Math.min(...shapes.map((shape) => shape.y));
      const width = Math.max(...shapes.map((shape) => editor.getShapePageBounds(shape)?.w ?? KAN_NODE_WIDTH)) + 40;
      const height = Math.max(...shapes.map((shape) => editor.getShapePageBounds(shape)?.h ?? KAN_NODE_HEIGHT)) + 40;
      const columns = operation.layout === "row" ? shapes.length : operation.layout === "column" ? 1 : Math.ceil(Math.sqrt(shapes.length));
      shapes.forEach((shape, i) => {
        puts.push({ ...shape, x: x + (i % columns) * width, y: y + Math.floor(i / columns) * height, meta: { ...shape.meta, provenance } });
        touched.add(shape.id);
      });
    }
  }
  if (touched.size > 500) throw new Error("This request exceeds the canvas action limit");
  const planned = [...new Map(puts.map(shape => [shape.id, shape])).values()];
  editor.run(() => {
    editor.createShapes(planned.filter((shape) => !current.has(shape.id)));
    editor.updateShapes(planned.filter((shape) => current.has(shape.id)));
    editor.createBindings(diagramBindings);
    editor.createBindings<TLArrowBinding>(bindings.map(({ terminal, ...binding }) => ({ ...binding, type: "arrow", props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" } })));
  });
  for (const shapeIds of groupRequests) {
    const group = createCanvasTools(editor).groupNodes({ shapeIds });
    touched.add(group.shapeId);
    group.memberShapeIds.forEach((id) => touched.add(id));
  }
  focusCreatedShapes(editor, [...created]);
  return [...touched];
}
