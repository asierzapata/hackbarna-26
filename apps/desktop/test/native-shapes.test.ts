import assert from "node:assert/strict";
import { test } from "node:test";
import type { Editor, TLShapeId } from "tldraw";
import { buildCanvasPrompt } from "../src/lib/canvas-agent";
import { canvasThinkingTargets } from "../src/lib/agent-thinking";
import { draftToShapePartial } from "../src/nodes/draft";
import { createCanvasTools } from "../src/nodes/tools";
import { geoShapeKind, nodeDraft } from "../src/nodes/schema";
import { executeCanvasTool } from "../src/lib/canvas-agent";
import { applyAssistantOperations } from "../src/lib/assistant-canvas";
import { MutationSchema } from "@kan/protocol";

const position = { x: 20, y: 30 };

function nativeDraft(input: unknown) {
  return draftToShapePartial(
    nodeDraft.parse(input),
    "shape:native" as TLShapeId,
    position,
  );
}

test("native geo drafts create tldraw geo shapes with text and geometry", () => {
  const rectangle = nativeDraft({
    type: "geo",
    geo: "rectangle",
    text: "Hi",
    w: 240,
    h: 120,
  });
  assert.equal(rectangle.type, "geo");
  assert.deepEqual(rectangle.props?.geo, "rectangle");
  assert.deepEqual(rectangle.props?.w, 240);
  assert.deepEqual(rectangle.props?.h, 120);
  assert.match(JSON.stringify(rectangle.props?.richText), /Hi/);

  const circle = nativeDraft({ type: "geo", geo: "ellipse", text: "Circle" });
  assert.equal(circle.props?.w, 200);
  assert.equal(circle.props?.h, 200);

  const oneDimensionEllipse = nativeDraft({ type: "geo", geo: "ellipse", w: 144 });
  assert.equal(oneDimensionEllipse.props?.w, 144);
  assert.equal(oneDimensionEllipse.props?.h, 200);
  const oval = nativeDraft({ type: "geo", geo: "ellipse", w: 144, h: 120 });
  assert.equal(oval.props?.w, 144);
  assert.equal(oval.props?.h, 120);

  for (const geo of geoShapeKind.options) {
    assert.equal(nodeDraft.parse({ type: "geo", geo }).type, "geo");
  }
  assert.throws(() => nodeDraft.parse({ type: "geo", geo: "oval" }));
});

test("native boxes participate in near placement collision checks", () => {
  const near = { id: "shape:near", type: "geo" };
  const blocker = { id: "shape:blocker", type: "geo" };
  const shapes = new Map([
    [near.id, near],
    [blocker.id, blocker],
  ]);
  const bounds = new Map([
    [near.id, { x: 0, y: 0, w: 100, h: 100 }],
    [blocker.id, { x: 140, y: 0, w: 200, h: 200 }],
  ]);
  const created: Array<{ x?: number; y?: number }> = [];
  const editor = {
    getCurrentPageShapeIds: () => new Set([near.id, blocker.id]),
    getCurrentPageShapes: () => [...shapes.values()],
    getShape: (id: string) => shapes.get(id),
    getShapePageBounds: (shape: string | { id: string }) => bounds.get(typeof shape === "string" ? shape : shape.id),
    getViewportPageBounds: () => ({ x: 0, y: 0, w: 1000, h: 800 }),
    run: (callback: () => void) => callback(),
    createShape: (shape: { x?: number; y?: number }) => created.push(shape),
    centerOnPoint: () => undefined,
    options: { animationMediumMs: 100 },
  } as unknown as Editor;

  createCanvasTools(editor).addNode({
    draft: { type: "geo", geo: "rectangle", w: 200, h: 200 },
    near: { shapeId: near.id },
  });

  assert.equal(created[0].x, 0);
  assert.equal(created[0].y, 140);
});

test("native geo full canvas output retains all props", () => {
  const props = {
    geo: "rectangle",
    w: 240,
    h: 120,
    url: "https://example.com",
    color: "red",
    fill: "solid",
  };
  const native = {
    id: "shape:native",
    type: "geo",
    x: 20,
    y: 30,
    props,
    meta: { source: "test" },
  };
  const editor = {
    getCurrentPageShapes: () => [native],
    getShapePageBounds: () => ({ x: 20, y: 30, w: 240, h: 120 }),
    getShapeUtil: () => ({ getText: () => "Label" }),
  } as unknown as Editor;

  const canvas = createCanvasTools(editor).getCanvas({ scope: "full" }) as { shapes: Array<{ props: unknown; meta: unknown }> };
  assert.deepEqual(canvas.shapes[0].props, props);
  assert.deepEqual(canvas.shapes[0].meta, { source: "test" });
});

test("native geo updates preserve the existing ID and style/link props", () => {
  const shape = {
    id: "shape:ellipse",
    type: "geo",
    props: {
      geo: "ellipse",
      w: 100,
      h: 100,
      url: "https://example.com",
      color: "blue",
      fill: "solid",
      richText: { type: "doc", content: [] },
    },
  };
  let update: unknown;
  const editor = {
    getShape: () => shape,
    run: (callback: () => void) => callback(),
    updateShape: (value: unknown) => { update = value; },
  } as unknown as Editor;

  const result = createCanvasTools(editor).updateNode({
    shapeId: shape.id,
    patch: { type: "geo", text: "Updated", w: 140 },
  });

  assert.deepEqual(result, { shapeId: shape.id });
  assert.equal((update as { id: string }).id, shape.id);
  assert.equal((update as { type: string }).type, "geo");
  const updateProps = (update as { props: { w: number; h?: number; richText: unknown } }).props;
  assert.equal(updateProps.w, 140);
  assert.equal(updateProps.h, undefined);
  assert.ok(updateProps.richText);
  const mergedProps = { ...shape.props, ...updateProps };
  assert.equal(mergedProps.h, 100);
  assert.equal(mergedProps.url, shape.props.url);
  assert.equal(mergedProps.color, shape.props.color);
});

test("native star color updates survive tool validation without replacing the shape", () => {
  const shape = { id: "shape:star", type: "geo", props: { geo: "star", color: "black", fill: "none", w: 200, h: 200 } };
  let update: { props?: object } | undefined;
  const editor = {
    getShape: () => shape,
    run: (callback: () => void) => callback(),
    updateShape: (value: typeof update) => { update = value; },
  } as unknown as Editor;
  const tools = createCanvasTools(editor);
  executeCanvasTool(tools, "updateNode", { shapeId: shape.id, patch: { type: "geo", color: "blue" } });
  assert.deepEqual(update, { id: shape.id, type: "geo", props: { color: "blue" } });
  assert.deepEqual({ ...shape.props, ...update?.props }, { ...shape.props, color: "blue" });
  assert.throws(() => executeCanvasTool(tools, "updateNode", { shapeId: shape.id, patch: { type: "geo", color: "not-a-color" } }));
  assert.throws(() => executeCanvasTool(tools, "updateNode", { shapeId: shape.id, patch: { type: "geo", colour: "blue" } }));
});

test("structured color operations preserve the native star and reject non-geo targets", () => {
  const shape = { id: "shape:star", typeName: "shape", type: "geo", props: { geo: "star", color: "black", fill: "none" }, meta: {} };
  const updates: unknown[] = [];
  const editor = {
    getSnapshot: () => ({ document: { store: { [shape.id]: shape } } }),
    run: (callback: () => void) => callback(),
    createShapes: () => {},
    updateShapes: (shapes: unknown[]) => updates.push(...shapes),
    createBindings: () => {},
  } as unknown as Editor;
  const operation = MutationSchema.parse({ type: "style", shapeId: shape.id, color: "blue" });
  assert.deepEqual(applyAssistantOperations(editor, [operation], { entryId: "test" }), [shape.id]);
  assert.deepEqual(updates, [{ ...shape, props: { ...shape.props, color: "blue" }, meta: { provenance: { entryId: "test" } } }]);
  shape.type = "kan-node";
  assert.throws(() => applyAssistantOperations(editor, [operation], {}), /geometric/);
});

test("focusNodes validates current-page IDs before moving only the camera", () => {
  const cameraCalls: unknown[] = [];
  const shapes = new Map([
    ["shape:a", { id: "shape:a" }],
    ["shape:b", { id: "shape:b" }],
    ["shape:off", { id: "shape:off" }],
  ]);
  const bounds = new Map([
    ["shape:a", { x: 10, y: 20, w: 100, h: 80 }],
    ["shape:b", { x: 180, y: 120, w: 40, h: 60 }],
  ]);
  const editor = {
    getCurrentPageShapeIds: () => new Set(["shape:a", "shape:b"]),
    getShape: (id: string) => shapes.get(id),
    getShapePageBounds: (shape: { id: string }) => bounds.get(shape.id),
    zoomToBounds: (value: unknown) => cameraCalls.push(value),
    options: { animationMediumMs: 100 },
  } as unknown as Editor;
  const tools = createCanvasTools(editor);

  assert.throws(
    () => tools.focusNodes({ shapeIds: ["shape:a", "shape:missing"] }),
    /current page/,
  );
  assert.throws(
    () => tools.focusNodes({ shapeIds: ["shape:a", "shape:off"] }),
    /current page/,
  );
  assert.equal(cameraCalls.length, 0);

  assert.deepEqual(tools.focusNodes({ shapeIds: ["shape:a", "shape:b"] }), {
    shapeIds: ["shape:a", "shape:b"],
    bounds: { x: 10, y: 20, w: 210, h: 160 },
  });
  assert.equal(cameraCalls.length, 1);
  assert.deepEqual(cameraCalls[0], { x: 10, y: 20, w: 210, h: 160 });
});

test("native shape prompts and thinking targets prefer focusNodes", () => {
  const prompt = buildCanvasPrompt("make a box hi and a circle bye");
  assert.match(prompt, /native tldraw geo shapes/i);
  assert.match(prompt, /never substitute markdown, SVG, or image/i);
  assert.match(prompt, /geo.*rectangle.*240.*120/);
  assert.match(prompt, /geo.*ellipse.*160.*160/);
  assert.match(prompt, /focusNodes/);
  assert.match(prompt, /never use arrange just to change the camera/i);
  assert.deepEqual(canvasThinkingTargets("focusNodes", { shapeIds: ["shape:a", "shape:a", "shape:b"] }), ["shape:a", "shape:b"]);
});
