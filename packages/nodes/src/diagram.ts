import { DiagramInputSchema, type DiagramInput } from "@kan/protocol";
import { createShapeId, toRichText, type TLArrowBinding, type TLArrowShape, type TLFrameShape, type TLGeoShape, type TLPageId, type TLShapeId, type TLShapePartial } from "@tldraw/tlschema";

type Box = { id: string; x: number; y: number; w: number; h: number };
type Edge = { from: string; to: string };
const GAP = 80;
const PADDING = 32;

function layout(items: Array<{ id: string; w: number; h: number }>, edges: Edge[], direction: "right" | "down"): Box[] {
  const ids = new Set(items.map(item => item.id));
  const links = edges.filter(edge => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);
  const levels = new Map(items.map(item => [item.id, 0]));
  const pending = new Set(ids);
  while (pending.size) {
    const ready = [...pending].filter(id => !links.some(edge => edge.to === id && pending.has(edge.from)));
    const next = ready.length ? ready : [[...pending][0]];
    for (const id of next) {
      pending.delete(id);
      for (const edge of links.filter(edge => edge.from === id && pending.has(edge.to))) {
        levels.set(edge.to, Math.max(levels.get(edge.to)!, levels.get(id)! + 1));
      }
    }
  }
  if (!links.length) {
    const columns = Math.ceil(Math.sqrt(items.length));
    const w = Math.max(...items.map(item => item.w)) + GAP;
    const h = Math.max(...items.map(item => item.h)) + GAP;
    return items.map((item, i) => ({ ...item, x: (i % columns) * w, y: Math.floor(i / columns) * h }));
  }
  const boxes: Box[] = [];
  let primary = 0;
  for (let level = 0; level <= Math.max(...levels.values()); level++) {
    const layer = items.filter(item => levels.get(item.id) === level);
    let secondary = 0;
    for (const item of layer) {
      boxes.push({ ...item, x: direction === "right" ? primary : secondary, y: direction === "right" ? secondary : primary });
      secondary += (direction === "right" ? item.h : item.w) + GAP;
    }
    primary += Math.max(0, ...layer.map(item => direction === "right" ? item.w : item.h)) + GAP;
  }
  return boxes;
}

export function diagramPlacement(shapes: Iterable<{ type?: string; parentId?: string; x?: number; y?: number; props?: unknown }>, pageId: string, fallback = { x: 80, y: 80 }) {
  const boxes = [...shapes].filter(shape => shape.parentId === pageId && shape.type !== "arrow" && Number.isFinite(shape.x) && Number.isFinite(shape.y));
  if (!boxes.length) return fallback;
  return { x: Math.max(...boxes.map(shape => shape.x! + (Number((shape.props as { w?: number })?.w) || 320))) + GAP, y: Math.min(...boxes.map(shape => shape.y!)) };
}

export function planDiagram(input: DiagramInput, options: { id: (key: string) => string; pageId: string; origin: { x: number; y: number }; provenance: TLGeoShape["meta"] }) {
  const diagram = DiagramInputSchema.parse(input);
  const sizes = diagram.nodes.map(node => {
    const h = Math.max(node.geo === "diamond" ? 200 : node.geo === "ellipse" ? 240 : 120, Math.ceil(node.label.length / (node.geo === "diamond" ? 14 : 20)) * 32 + 48);
    return { id: node.id, w: node.geo === "diamond" ? 300 : node.geo === "ellipse" ? h : 240, h };
  });
  const groups = diagram.groups.map(group => {
    const children = layout(sizes.filter(size => diagram.nodes.some(node => node.id === size.id && node.group === group.id)), diagram.edges, diagram.direction);
    return { ...group, children, w: Math.max(...children.map(box => box.x + box.w)) + PADDING * 2, h: Math.max(...children.map(box => box.y + box.h)) + PADDING * 2 };
  });
  const cluster = (id: string) => {
    const node = diagram.nodes.find(node => node.id === id)!;
    return node.group ? `g:${node.group}` : `n:${id}`;
  };
  const outer = layout([
    ...sizes.filter(size => !diagram.nodes.find(node => node.id === size.id)!.group).map(size => ({ ...size, id: `n:${size.id}` })),
    ...groups.map(group => ({ id: `g:${group.id}`, w: group.w, h: group.h })),
  ], diagram.edges.map(edge => ({ from: cluster(edge.from), to: cluster(edge.to) })), diagram.direction);
  const shapeId = (key: string) => createShapeId(options.id(key));
  const pageId = options.pageId as TLPageId;
  const shapes: TLShapePartial<TLGeoShape | TLFrameShape | TLArrowShape>[] = [];
  const bindings: Array<Omit<TLArrowBinding, "id" | "typeName"> & { id?: TLArrowBinding["id"] }> = [];
  const nodeBoxes = new Map<string, Box & { shapeId: TLShapeId; parentId: TLPageId | TLShapeId }>();
  for (const group of groups) {
    const box = outer.find(box => box.id === `g:${group.id}`)!;
    const id = shapeId(`group-${group.id}`);
    shapes.push({ id, type: "frame", parentId: pageId, x: options.origin.x + box.x, y: options.origin.y + box.y, props: { w: box.w, h: box.h, name: group.label, color: "black" }, meta: { provenance: options.provenance, kanGroup: true } });
    for (const child of group.children) nodeBoxes.set(child.id, { ...child, x: child.x + box.x + PADDING, y: child.y + box.y + PADDING, shapeId: shapeId(`node-${child.id}`), parentId: id });
  }
  for (const node of diagram.nodes) {
    const box = nodeBoxes.get(node.id) ?? { ...outer.find(box => box.id === `n:${node.id}`)!, shapeId: shapeId(`node-${node.id}`), parentId: pageId };
    nodeBoxes.set(node.id, box);
    const parent = node.group ? outer.find(box => box.id === `g:${node.group}`)! : null;
    shapes.push({ id: box.shapeId, type: "geo", parentId: box.parentId,
      x: parent ? box.x - parent.x : box.x + options.origin.x, y: parent ? box.y - parent.y : box.y + options.origin.y,
      props: { w: box.w, h: box.h, geo: node.geo ?? "rectangle", color: node.color ?? "black", labelColor: "black", fill: "none", dash: "solid", size: "m", font: "sans", align: "middle", verticalAlign: "middle", growY: 0, url: "", scale: 1, flipX: false, flipY: false, richText: toRichText(node.label) }, meta: { provenance: options.provenance } });
  }
  diagram.edges.forEach((edge, index) => {
    const from = nodeBoxes.get(edge.from)!, to = nodeBoxes.get(edge.to)!;
    const id = shapeId(`edge-${index}`);
    const sameGroup = from.parentId === to.parentId && from.parentId !== pageId;
    const frame = sameGroup ? shapes.find(shape => shape.id === from.parentId)! : null;
    const x = options.origin.x + from.x + from.w / 2, y = options.origin.y + from.y + from.h / 2;
    shapes.push({ id, type: "arrow", parentId: sameGroup ? from.parentId : pageId,
      x: x - (frame?.x ?? 0), y: y - (frame?.y ?? 0),
      props: { kind: "arc", labelColor: "black", color: "black", fill: "none", dash: "solid", size: "m", arrowheadStart: "none", arrowheadEnd: "arrow", font: "sans", start: { x: 0, y: 0 }, end: { x: to.x + to.w / 2 - from.x - from.w / 2, y: to.y + to.h / 2 - from.y - from.h / 2 }, bend: 0, richText: toRichText(edge.label ?? ""), labelPosition: 0.5, scale: 1, elbowMidPoint: 0.5 }, meta: { provenance: options.provenance } });
    for (const [terminal, target] of [["start", from], ["end", to]] as const) bindings.push({ id: `binding:${options.id(`edge-${index}-${terminal}`)}` as TLArrowBinding["id"], type: "arrow", fromId: id, toId: target.shapeId, props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" }, meta: {} });
  });
  return { shapes, bindings };
}
