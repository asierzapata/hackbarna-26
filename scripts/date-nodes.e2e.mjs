import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./drive.mjs", import.meta.url));
const drive = (...args) => JSON.parse(execFileSync(process.execPath, [driver, ...args], { encoding: "utf8", timeout: 15000 }));
const evaluate = (expression) => drive("eval", `({result: (${expression})})`).result;
const run = (body) => evaluate(`(() => { ${body} })()`);
const created = [];
const camera = evaluate("window.__kan.editor.getCamera()");
const initialErrors = evaluate("window.__kanErrors ?? []");
const events = [
  { id: "review", title: "Review", start: "2026-10-02", description: "Discuss the findings." },
  { id: "study", title: "Study", start: "2026-09-29", end: "2026-10-02", description: "Read and compare the evidence.", sourceNote: "Reading list" },
];
const add = (draft, at) => {
  const { shapeId } = evaluate(`window.__kan.tools.addNode(${JSON.stringify({ draft, at })})`);
  created.push(shapeId);
  return shapeId;
};
const patch = (shapeId, patch) => evaluate(`window.__kan.tools.updateNode(${JSON.stringify({ shapeId, patch })})`);
const state = (id) => evaluate(`window.__kan.tools.getCanvas({scope:"full",shapeIds:[${JSON.stringify(id)}]}).shapes[0]`);
const selector = (id, child = "") => `[data-shape-id="${id}"] ${child}`.trim();
const click = (id, child) => drive("click", selector(id, child));
const text = (id, child) => evaluate(`document.querySelector(${JSON.stringify(selector(id, child))})?.textContent ?? ""`);

try {
  const timeline = add({ type: "timeline", title: "E2E timeline", events }, { x: 3000, y: 0 });
  const calendar = add({ type: "calendar", title: "E2E calendar", events }, { x: 3480, y: 0 });
  run("window.__kan.editor.zoomToBounds({x:2960,y:-30,w:1080,h:640}); return true;");
  assert.equal(state(calendar).props.month, "2026-09");
  assert.deepEqual(evaluate(`[...document.querySelectorAll(${JSON.stringify(selector(timeline, "[data-event-id]"))})].map(el=>el.dataset.eventId)`), ["study", "review"]);
  click(timeline, '[data-event-id="study"] button');
  assert.equal(state(timeline).props.selectedEventId, "study");
  assert.match(text(timeline, "[data-event-details]"), /Read and compare.*Reading list/);
  click(timeline, '[data-event-id="study"] button');
  assert.equal(state(timeline).props.selectedEventId, null);
  console.log("PASS timeline sorting, expansion, collapse, and shared selection");

  click(calendar, '[data-calendar-date="2026-09-30"]');
  assert.equal(state(calendar).props.selectedDate, "2026-09-30");
  assert.match(text(calendar, '[aria-label="Selected day events"]'), /Study/);
  click(calendar, '[aria-label="Next month"]');
  assert.equal(state(calendar).props.month, "2026-10");
  assert.equal(state(calendar).props.selectedDate, null);
  click(calendar, '[data-calendar-date="2026-10-02"]');
  assert.equal(evaluate(`document.querySelectorAll(${JSON.stringify(selector(calendar, "[data-calendar-event]"))}).length`), 2);
  click(calendar, '[data-calendar-date="2026-10-03"]');
  assert.match(text(calendar, '[aria-label="Selected day events"]'), /No events on this day/);
  click(calendar, '[aria-label="Previous month"]');
  assert.equal(state(calendar).props.month, "2026-09");
  console.log("PASS calendar navigation, date selection, inclusive cross-month ranges, and empty day");

  patch(calendar, { type: "calendar", month: "2026-12" });
  click(calendar, '[aria-label="Next month"]');
  assert.equal(state(calendar).props.month, "2027-01");
  patch(calendar, { type: "calendar", month: "2024-02" });
  assert.equal(evaluate(`document.querySelectorAll(${JSON.stringify(selector(calendar, "[data-calendar-date]"))}).length`), 29);
  run(`const root = document.querySelector(${JSON.stringify(selector(calendar))}); [...root.querySelectorAll("button")].find(button=>button.textContent === "Today").click(); return true;`);
  assert.equal(state(calendar).props.selectedDate, evaluate('(() => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })()'));
  console.log("PASS year rollover, leap-year calendar, and Today");

  patch(timeline, { type: "timeline", selectedEventId: "study" });
  patch(timeline, { type: "timeline", events: [...events].reverse(), w: 460, h: 480 });
  assert.equal(state(timeline).props.selectedEventId, "study");
  assert.equal(state(timeline).props.w, 460);
  patch(timeline, { type: "timeline", events: [events[0]] });
  assert.equal(state(timeline).props.selectedEventId, null);
  patch(calendar, { type: "calendar", selectedDate: "2026-10-02" });
  assert.equal(state(calendar).props.month, "2026-10");
  patch(calendar, { type: "calendar", month: "2026-11" });
  assert.equal(state(calendar).props.selectedDate, null);
  const summary = evaluate("window.__kan.tools.getCanvas()");
  assert.equal(summary.nodes.find(node => node.id === calendar).month, "2026-11");
  assert.equal(summary.nodes.find(node => node.id === timeline).eventCount, 1);
  console.log("PASS tool updates, selection reconciliation, geometry, and canvas summaries");

  const before = state(calendar);
  assert.ok(run(`try { window.__kan.tools.updateNode(${JSON.stringify({ shapeId: calendar, patch: { type: "calendar", events: [{ id: "bad", title: "Invalid", start: "2026-02-30" }] } })}); return false; } catch { return true; }`));
  assert.deepEqual(state(calendar), before);
  assert.ok(run(`try { window.__kan.tools.addNode(${JSON.stringify({ draft: { type: "timeline", title: "Invalid", events: [events[0], events[0]] } })}); return false; } catch { return true; }`));
  console.log("PASS malformed updates and duplicate IDs rejected without mutation");

  const position = state(timeline);
  run(`window.__kan.editor.setCurrentTool("select"); window.__kan.editor.zoomToBounds(${JSON.stringify({ x: position.x - 80, y: position.y - 60, w: 1060, h: 640 })}); return true;`);
  drive("drag", selector(timeline, '[data-event-id="review"] button'), "25", "15");
  assert.equal(state(timeline).x, position.x);
  assert.equal(state(timeline).y, position.y);
  drive("drag", selector(timeline, '[data-slot="card-header"]'), "35", "20");
  const moved = state(timeline);
  assert.ok(moved.x !== position.x || moved.y !== position.y);
  console.log("PASS controls do not drag the node; card header does");

  patch(timeline, { type: "timeline", events: [] });
  patch(calendar, { type: "calendar", events: [], selectedDate: null });
  assert.match(text(timeline, '[data-slot="empty"]'), /No events yet/);
  assert.match(text(calendar, '[data-slot="empty"]'), /No events yet/);
  evaluate(`window.__kan.tools.connectNodes(${JSON.stringify({ from: timeline, to: calendar, label: "schedule" })})`);
  evaluate(`window.__kan.tools.arrange(${JSON.stringify({ shapeIds: [timeline, calendar], layout: "row" })})`);
  assert.ok(state(calendar).x >= state(timeline).x + state(timeline).props.w);
  assert.ok(evaluate("window.__kan.tools.getCanvas().connections").some(connection => connection.from === timeline && connection.to === calendar));
  assert.deepEqual(evaluate("window.__kanErrors ?? []"), initialErrors);
  console.log("PASS empty nodes, connections, arrangement, and no new runtime errors");
} finally {
  if (created.length) evaluate(`window.__kan.tools.removeNodes(${JSON.stringify({ shapeIds: created })})`);
  run(`window.__kan.editor.setCamera(${JSON.stringify({ x: camera.x, y: camera.y, z: camera.z })}); return true;`);
}
assert.ok(evaluate("window.__kan.tools.getCanvas().nodes").every(node => !created.includes(node.id)));
assert.ok(evaluate("window.__kan.tools.getCanvas().connections").every(connection => !created.includes(connection.from) && !created.includes(connection.to)));
console.log("PASS cleanup removed only test nodes and their connection");
