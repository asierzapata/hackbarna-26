import { createShapeId, toRichText, type Editor, type TLArrowBinding, type TLShape, type TLShapeId, type TLShapePartial } from "tldraw";
import { KAN_NODE_HEIGHT, KAN_NODE_WIDTH } from "@kan/nodes";
import { MutationSchema, type Mutation } from "@kan/protocol";

export function assistantCanvasRecords(editor: Editor | null) {
  if (!editor) return [];
  return Object.values(editor.getSnapshot().document.store).filter((record) => record.typeName === "shape");
}

export function applyAssistantOperations(editor: Editor, input: Mutation[], provenance: Record<string, string>): string[] {
  const operations = input.map((operation) => MutationSchema.parse(operation));
  const puts: TLShapePartial[] = [];
  const bindings: Array<{ fromId: TLShapeId; toId: TLShapeId; terminal: "start" | "end" }> = [];
  const current = new Map(assistantCanvasRecords(editor).map((shape) => [shape.id, shape as TLShape]));
  const touched = new Set<string>();
  const get = (id: string) => {
    const shape = current.get(id as TLShapeId);
    if (!shape) throw new Error("A referenced canvas item no longer exists");
    if (shape.isLocked) throw new Error("Unlock the referenced item before changing it");
    return shape;
  };
  const topLevel = (shape: TLShape) => {
    if (!shape.parentId.startsWith("page:") || shape.rotation !== 0) throw new Error("This operation requires unrotated top-level items");
  };
  for (const [index, operation] of operations.entries()) {
    if (operation.type === "add") {
      const id = (operation.shapeId ?? createShapeId(`${provenance.entryId}-${index}`)) as TLShapeId;
      if (current.has(id)) throw new Error("That canvas action was already applied");
      const near = operation.nearShapeId ? get(operation.nearShapeId) : undefined;
      if (near) topLevel(near);
      const viewport = editor.getViewportPageBounds();
      const shape: TLShapePartial = { id, type: "kan-node", parentId: near?.parentId ?? editor.getCurrentPageId(), x: operation.x ?? (near ? near.x + Number((near.props as { w?: number }).w ?? KAN_NODE_WIDTH) + 40 : viewport.x + 80 + index * 40), y: operation.y ?? (near?.y ?? viewport.y + 80 + index * 40), props: { w: KAN_NODE_WIDTH, h: KAN_NODE_HEIGHT, draft: operation.draft }, meta: { provenance } };
      puts.push(shape);
      touched.add(id);
    } else if (operation.type === "update") {
      const shape = get(operation.shapeId);
      if (shape.type !== "kan-node") throw new Error("Only shared Kan cards can be updated by this action");
      puts.push({ ...shape, props: { ...shape.props, draft: operation.draft }, meta: { ...shape.meta, provenance } } as TLShapePartial);
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
  editor.run(() => {
    editor.createShapes(puts.filter((shape) => !current.has(shape.id)));
    editor.updateShapes(puts.filter((shape) => current.has(shape.id)));
    editor.createBindings<TLArrowBinding>(bindings.map(({ terminal, ...binding }) => ({ ...binding, type: "arrow", props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" } })));
  });
  return [...touched];
}
