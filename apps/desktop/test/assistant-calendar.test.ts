import assert from "node:assert/strict";
import { test } from "node:test";
import type { Editor, TLShapeId } from "tldraw";
import { buildAssistantPrompt, MutationSchema, NodeDraftSchema } from "@kan/protocol";
import { applyAssistantOperations } from "../src/lib/assistant-canvas";
import { draftToShapePartial } from "../src/nodes/draft";
import { nodeDraft } from "../src/nodes/schema";

const calendar = { type: "calendar", title: "September 2026", events: [], month: "2026-09", selectedDate: "2026-09-20" };

test("structured calendar drafts accept real dates and reject invalid dates and duplicate events", () => {
  assert.deepEqual(NodeDraftSchema.parse(calendar), calendar);
  for (const selectedDate of ["2026-02-30", "0000-01-01", "2026-09-20T00:00:00Z"]) {
    assert.equal(NodeDraftSchema.safeParse({ ...calendar, selectedDate }).success, false);
  }
  const event = { id: "event", title: "Planning", start: "2026-09-20" };
  assert.equal(NodeDraftSchema.safeParse({ ...calendar, events: [event, event] }).success, false);
  assert.equal(NodeDraftSchema.safeParse({ ...calendar, events: [{ ...event, end: "2026-09-19" }] }).success, false);
  assert.equal(NodeDraftSchema.safeParse({ ...calendar, selectedDate: "0001-01-01" }).success, true);
});

test("calendar tools and structured additions create the rich calendar with selected day visible", () => {
  const draft = nodeDraft.parse({ ...calendar, month: "2026-08" });
  const rich = draftToShapePartial(draft, "shape:calendar" as TLShapeId, { x: 10, y: 20 });
  assert.equal(rich.type, "kan-calendar");
  assert.equal(rich.props?.selectedDate, "2026-09-20");
  assert.equal(rich.props?.month, "2026-09");
  const created: unknown[] = [];
  const editor = {
    getSnapshot: () => ({ document: { store: {} } }),
    getCurrentPageId: () => "page:page",
    getViewportPageBounds: () => ({ x: 0, y: 0 }),
    run: (fn: () => void) => fn(),
    createShapes: (shapes: unknown[]) => created.push(...shapes),
    updateShapes: () => {},
    createBindings: () => {},
  } as unknown as Editor;
  const operation = MutationSchema.parse({ type: "add", shapeId: "shape:calendar", draft: calendar });
  applyAssistantOperations(editor, [operation], { entryId: "entry" });
  assert.equal((created[0] as { type: string }).type, "kan-calendar");
  assert.deepEqual((created[0] as { props: unknown }).props, { ...rich.props });
});

test("structured calendar updates preserve the existing rich node geometry", () => {
  const shape = { ...draftToShapePartial(nodeDraft.parse(calendar), "shape:calendar" as TLShapeId, { x: 10, y: 20 }), typeName: "shape", parentId: "page:page" };
  const updated: any[] = [];
  const editor = {
    getSnapshot: () => ({ document: { store: { [shape.id]: shape } } }),
    run: (fn: () => void) => fn(), createShapes: () => {}, createBindings: () => {},
    updateShapes: (shapes: unknown[]) => updated.push(...shapes),
  } as unknown as Editor;
  const operation = MutationSchema.parse({ type: "update", shapeId: shape.id, draft: { ...calendar, selectedDate: "2026-10-03" } });
  applyAssistantOperations(editor, [operation], { entryId: "update" });
  assert.equal(updated[0].type, "kan-calendar");
  assert.equal(updated[0].props.month, "2026-10");
  assert.equal(updated[0].props.selectedDate, "2026-10-03");
  assert.equal(updated[0].props.w, shape.props?.w);
  assert.equal(updated[0].x, 10);
});

test("structured prompt offers a real calendar and supplies a trusted local date", () => {
  const prompt = buildAssistantPrompt("act", {});
  assert.match(prompt, /"type":"calendar"/);
  assert.match(prompt, /never.*table.*calendar/i);
  assert.match(prompt, /Today's local date is \d{4}-\d{2}-\d{2}/);
});
