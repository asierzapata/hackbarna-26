import assert from "node:assert/strict";
import { test } from "node:test";
import type { Editor } from "tldraw";
import { AssistantResultSchema, MutationSchema } from "@kan/protocol";
import { applyAssistantOperations } from "../src/lib/assistant-canvas";

const diagram = {
  type: "diagram", nodes: [{ id: "pizza", label: "Pizza", group: "food" }, { id: "salad", label: "Salad", group: "food" }],
  groups: [{ id: "food", label: "Food options" }], edges: [{ from: "pizza", to: "salad", label: "or" }],
};

function fixture() {
  const shapes: any[] = [], bindings: any[] = [];
  const editor = {
    getSnapshot: () => ({ document: { store: Object.fromEntries(shapes.map(shape => [shape.id, shape])) } }),
    getCurrentPageId: () => "page:page",
    getViewportPageBounds: () => ({ x: 0, y: 0 }),
    run: (fn: () => void) => fn(),
    createShapes: (values: any[]) => shapes.push(...values), updateShapes: (values: any[]) => values.forEach(value => Object.assign(shapes.find(shape => shape.id === value.id), value)),
    createBindings: (values: any[]) => bindings.push(...values),
  } as unknown as Editor;
  return { editor, shapes, bindings };
}

test("one structured turn supports a calendar plus grouped editable diagram", () => {
  const result = AssistantResultSchema.parse({ kind: "act", text: "Added calendar and food options.", sources: [], operations: [
    { type: "add", draft: { type: "calendar", title: "Party", events: [{ id: "party", title: "Party", start: "2026-09-22" }] } }, diagram,
  ] });
  assert.equal(result.kind, "act");
  if (result.kind !== "act") return;
  const { editor, shapes, bindings } = fixture();
  const touched = applyAssistantOperations(editor, result.operations, { entryId: "test" });
  assert.equal(shapes.filter(shape => shape.type === "kan-calendar").length, 1);
  const frame = shapes.find(shape => shape.type === "frame");
  assert.equal(frame.props.name, "Food options");
  const boxes = shapes.filter(shape => shape.type === "geo");
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every(shape => shape.parentId === frame.id));
  assert.equal(shapes.filter(shape => shape.type === "arrow").length, 1);
  assert.equal(bindings.length, 2);
  assert.equal(touched.length, 5);
  const calendar = shapes.find(shape => shape.type === "kan-calendar");
  assert.ok(frame.x >= calendar.x + calendar.props.w + 40);
});

test("a single turn can revise a planet label and color without losing either update", () => {
  const { editor, shapes } = fixture();
  shapes.push({ id: "shape:mercury", typeName: "shape", type: "geo", parentId: "page:page", x: 0, y: 0, rotation: 0, props: { geo: "rectangle", color: "black", richText: { type: "doc", content: [] } }, meta: {} });
  applyAssistantOperations(editor, [{ type: "label", shapeId: "shape:mercury", text: "Mercury: 88 Earth days" }, { type: "style", shapeId: "shape:mercury", color: "grey" }], { entryId: "edit" });
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].props.color, "grey");
  assert.match(JSON.stringify(shapes[0].props.richText), /88 Earth days/);
});

test("invalid graph references and duplicate IDs fail before touching canvas", () => {
  for (const patch of [
    { nodes: [diagram.nodes[0], diagram.nodes[0]] },
    { edges: [{ from: "pizza", to: "missing" }] },
    { groups: [] },
    { groups: [{ id: "food", label: "Food" }, { id: "food", label: "Again" }] },
  ]) {
    const { editor, shapes } = fixture();
    assert.throws(() => applyAssistantOperations(editor, [{ ...diagram, ...patch }] as never, { entryId: "invalid" }));
    assert.equal(shapes.length, 0);
  }
});

test("a graph batch is bounded independently of the eight-operation response limit", () => {
  assert.equal(MutationSchema.safeParse({ ...diagram, nodes: Array.from({ length: 41 }, (_, i) => ({ id: `n${i}`, label: "Node" })) }).success, false);
  assert.equal(MutationSchema.safeParse({ type: "diagram", nodes: [{ id: "one", label: "One" }], edges: [] }).success, true);
});
