import { createShapeId, toRichText, type TLArrowBinding, type TLShape, type TLShapeId, type TLShapePartial } from "@tldraw/tlschema";
import type { Editor } from "tldraw";
import { diagramPlacement, KAN_NODE_HEIGHT, KAN_NODE_WIDTH, planDiagram } from "@kan/nodes";
import { MutationSchema, type Mutation } from "@kan/protocol";
import { draftToShapePartial } from "@/nodes/draft";

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
      plan.shapes.forEach(shape => touched.add(shape.id));
    } else if (operation.type === "add") {
      const id = (operation.shapeId ?? createShapeId(`${provenance.entryId}-${index}`)) as TLShapeId;
      if (current.has(id) || puts.some(shape => shape.id === id)) throw new Error("That canvas action was already applied");
      const near = operation.nearShapeId ? get(operation.nearShapeId) : undefined;
      if (near) topLevel(near);
      const viewport = editor.getViewportPageBounds();
      const origin = diagramPlacement([...current.values(), ...puts], near?.parentId ?? editor.getCurrentPageId(), { x: viewport.x + 80, y: viewport.y + 80 });
      const position = { x: operation.x ?? origin.x, y: operation.y ?? near?.y ?? origin.y };
      const shape: TLShapePartial = operation.draft.type === "calendar"
        ? { ...draftToShapePartial(operation.draft, id, position), parentId: near?.parentId ?? editor.getCurrentPageId(), meta: { provenance } }
        : { id, type: "kan-node", parentId: near?.parentId ?? editor.getCurrentPageId(), ...position, props: { w: KAN_NODE_WIDTH, h: KAN_NODE_HEIGHT, draft: operation.draft }, meta: { provenance } };
      puts.push(shape);
      touched.add(id);
    } else if (operation.type === "update") {
      const shape = get(operation.shapeId);
      if (shape.type === "kan-calendar" && operation.draft.type === "calendar") {
        const draft = operation.draft;
        const month = draft.selectedDate?.slice(0, 7) ?? draft.month ?? shape.props.month;
        const selectedDate = draft.selectedDate === undefined ? shape.props.selectedDate : draft.selectedDate;
        puts.push({ ...shape, props: { ...shape.props, title: draft.title, events: draft.events, sourceNote: draft.sourceNote ?? "", month, selectedDate: selectedDate?.startsWith(`${month}-`) ? selectedDate : null }, meta: { ...shape.meta, provenance } });
      } else {
        if (shape.type !== "kan-node") throw new Error("Only shared Kan cards or rich calendars can be updated by this action");
        puts.push({ ...shape, props: { ...shape.props, draft: operation.draft }, meta: { ...shape.meta, provenance } } as TLShapePartial);
      }
      touched.add(shape.id);
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
  return [...touched];
}
