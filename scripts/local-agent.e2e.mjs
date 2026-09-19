import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./drive.mjs", import.meta.url));
const drive = (...args) => {
  const output = execFileSync(process.execPath, [driver, ...args], { encoding: "utf8", timeout: 15000 });
  return ["reload", "shot"].includes(args[0]) ? output.trim() : JSON.parse(output);
};
const evaluate = (expression) => drive("eval", `({result: (${expression})})`).result;
const run = (body) => evaluate(`(() => { ${body} })()`);
const waitFor = async (expression, timeout = 20000, failOnStopped = true) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (evaluate(expression)) return;
    if (failOnStopped && timeout === 240000) {
      const stopped = evaluate("(() => { const sim = document.querySelector('[data-testid=conversation-simulator]'); return sim?.dataset.playing === 'false' && Number(sim.dataset.cursor) > 0; })()");
      if (stopped) throw new Error(`Conversation stopped without satisfying: ${expression}`);
    }
    await pause(500);
  }
  throw new Error(`Timed out: ${expression}`);
};
const originalPath = evaluate("location.pathname");
const canvasId = randomUUID();
const path = `/canvas/${canvasId}`;
const keep = process.argv.includes("--keep");
const catalog = async (method, input) => {
  run(`window.__agentTestCatalog = null; import('/src/lib/canvas-repository.ts').then(repo => repo[${JSON.stringify(method)}](${JSON.stringify(input)})).then(() => { window.__agentTestCatalog = {ok:true}; }).catch(error => { window.__agentTestCatalog = {error:String(error)}; }); return true;`);
  await waitFor("window.__agentTestCatalog !== null");
  assert.equal(evaluate("window.__agentTestCatalog.ok"), true, evaluate("window.__agentTestCatalog.error"));
};

try {
  assert.equal(evaluate("!!window.__TAURI_INTERNALS__"), true);
  await catalog("createOfflineCanvas", { id: canvasId, name: "Devin conversation verification" });
  run(`location.assign(${JSON.stringify(path)}); return true;`);
  await waitFor("!!window.__kan && !!document.querySelector('[data-testid=conversation-simulator]')");
  assert.equal(evaluate("window.__kan.tools.getCanvas().nodes.length"), 0);

  if (!evaluate("document.querySelector('[data-testid=agent-status]')?.textContent.includes('Devin')")) {
    assert.equal(evaluate("!!document.querySelector('[data-testid=agent-status]')"), false, "Another provider is connected; select Devin first");
    drive("click", "[data-testid=sign-in-button]");
    drive("click", "[data-testid=sign-in-devin]");
    await waitFor("!!document.querySelector('[data-testid=sign-in-devin-subscription]')");
    drive("click", "[data-testid=sign-in-devin-subscription]");
    await waitFor("!!document.querySelector('[data-testid=agent-status]') || !!document.querySelector('[data-testid=agent-error]')", 120000);
    assert.equal(evaluate("document.querySelector('[data-testid=agent-error]')?.textContent ?? ''"), "");
  }
  assert.match(evaluate("document.querySelector('[data-testid=agent-status]').textContent"), /Devin.*connected/);
  console.log("PASS real local Devin connected through the app");

  run(`const slider = document.querySelector('[role=slider]'); slider.focus(); slider.dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true})); return true;`);
  drive("clickText", "Simulate conversation");
  await waitFor("window.__kan.tools.getCanvas().nodes.some(node => node.type === 'calendar')", 240000);
  console.log("PASS Devin created a calendar from the simulated transcript");
  await waitFor("window.__kan.tools.getCanvas().nodes.some(node => node.type === 'map')", 240000);
  console.log("PASS Devin created a map from the next conversation trigger");
  await waitFor("(() => { const sim = document.querySelector('[data-testid=conversation-simulator]'); return Number(sim?.dataset.cursor ?? 0) >= Number(sim?.dataset.total ?? 1) || !!sim?.querySelector('[role=alert]'); })()", 240000, false);
  assert.equal(evaluate("document.querySelector('[data-testid=conversation-simulator] [role=alert]')?.textContent ?? ''"), "");

  const shapes = evaluate("window.__kan.tools.getCanvas({scope:'full'}).shapes");
  const calendar = shapes.find(({ type }) => type === "calendar");
  const map = shapes.find(({ type }) => type === "map");
  const table = shapes.find(({ type }) => type === "table");
  assert.ok(calendar && map && table);
  assert.deepEqual(calendar.props.events.map(({ start }) => start).sort(), ["2026-09-19", "2026-09-20"]);
  assert.equal(map.props.markers.length, 2);
  for (const expected of [{ label: /glovo/i, lat: 41.403, lng: 2.194 }, { label: /norrsken/i, lat: 41.375, lng: 2.189 }]) {
    const marker = map.props.markers.find(({ label }) => expected.label.test(label));
    assert.ok(marker);
    assert.equal(marker.lat, expected.lat);
    assert.equal(marker.lng, expected.lng);
  }
  for (const sponsor of [/vonage/i, /cognition/i, /nebius/i, /preply/i]) assert.match(JSON.stringify(table.props.rows), sponsor);
  assert.equal(shapes.filter(({ type }) => type === "calendar").length, 1);
  assert.equal(shapes.filter(({ type }) => type === "map").length, 1);
  for (const shape of [calendar, map, table]) assert.equal(shape.meta.provenance.agentId, "assistant");
  assert.deepEqual(evaluate("window.__kanErrors"), []);
  assert.equal(evaluate("document.querySelector('[data-testid=conversation-simulator] [role=alert]')?.textContent ?? ''"), "");
  run("window.__kan.editor.zoomToFit(); return true;");
  await pause(500);
  console.log("PASS two calendar days, both map pins, four sponsors, provenance, no duplicate calendar/map, and no runtime errors");
  console.log(JSON.stringify({ canvasId, nodes: shapes.map(({ id, type, title }) => ({ id, type, title })) }, null, 2));
  if (keep) console.log("Verification canvas retained for inspection");
} catch (error) {
  console.error(JSON.stringify(drive("snapshot"), null, 2));
  throw error;
} finally {
  if (!keep && evaluate("location.pathname") === path) {
    run("const stop = document.querySelector('[aria-label=\"Stop simulated conversation\"]'); if (stop) stop.click(); const signOut = document.querySelector('[data-testid=agent-sign-out]'); if (signOut) signOut.click(); return true;");
    await waitFor("!document.querySelector('[data-testid=agent-sign-out]')");
    const ids = evaluate("window.__kan.editor.getCurrentPageShapes().map(shape => shape.id)");
    if (ids.length) evaluate(`window.__kan.tools.removeNodes(${JSON.stringify({shapeIds:ids})})`);
    await pause(1500);
    await catalog("deleteCanvasEntry", canvasId);
    run(`location.assign(${JSON.stringify(originalPath)}); return true;`);
    await waitFor(`location.pathname === ${JSON.stringify(originalPath)}`);
  }
}
