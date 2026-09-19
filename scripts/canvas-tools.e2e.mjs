import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { demoFixtures } from "../apps/desktop/src/nodes/demo-fixtures.ts";

const driver = fileURLToPath(new URL("./drive.mjs", import.meta.url));
const drive = (...args) => {
  const output = execFileSync(process.execPath, [driver, ...args], { encoding: "utf8", timeout: 15000 });
  return args[0] === "reload" ? output.trim() : JSON.parse(output);
};
const evaluate = (expression) => drive("eval", `({result: (${expression})})`).result;
const run = (body) => evaluate(`(() => { ${body} })()`);
const waitFor = async (expression) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (evaluate(expression)) return;
    await pause(200);
  }
  throw new Error(`Timed out: ${expression}`);
};
const originalPath = evaluate("location.pathname");
const originalHasEditor = evaluate("!!window.__kan");
const canvasId = randomUUID();
const path = `/canvas/${canvasId}`;
const catalog = async (method, args) => {
  run(`window.__kanE2ECatalog = null; import('/src/lib/canvas-repository.ts').then(repo => repo[${JSON.stringify(method)}](${JSON.stringify(args)})).then(() => { window.__kanE2ECatalog = { ok: true }; }).catch(error => { window.__kanE2ECatalog = { error: String(error) }; }); return true;`);
  await waitFor("window.__kanE2ECatalog !== null");
  assert.equal(evaluate("window.__kanE2ECatalog.ok"), true, evaluate("window.__kanE2ECatalog.error"));
};
const created = [];
const ids = {};
const state = (id) => evaluate(`window.__kan.tools.getCanvas({scope:"full",shapeIds:[${JSON.stringify(id)}]}).shapes[0]`);
const selector = (id, child = "") => `[data-shape-id="${id}"] ${child}`.trim();
const click = (id, child) => drive("click", selector(id, child));

try {
  await catalog("createOfflineCanvas", { id: canvasId, name: "E2E node tools" });
  run(`location.assign(${JSON.stringify(path)}); return true;`);
  await waitFor(`location.pathname === ${JSON.stringify(path)} && !!window.__kan`);
  assert.deepEqual(evaluate("window.__kan.editor.getCurrentPageShapes()"), []);
  const header = evaluate("document.querySelector('.header-bar').textContent");
  assert.doesNotMatch(header, /Run scenario|Read canvas|Arrange grid|Remove last|Timeline|Calendar/);
  assert.ok(evaluate("!!document.querySelector('.header-bar button')"));
  assert.deepEqual(evaluate("Object.keys(window.__kan.tools).sort()"), ["addNode", "arrange", "connectNodes", "getCanvas", "groupNodes", "removeNodes", "updateNode"]);
  console.log("PASS fresh offline canvas is empty, demo controls absent, sign-in and all seven tools retained");

  for (const [type, draft] of Object.entries(demoFixtures)) {
    const at = { x: created.length * 700, y: 0 };
    const { shapeId } = evaluate(`window.__kan.tools.addNode(${JSON.stringify({ draft, at })})`);
    created.push(shapeId);
    ids[type] = shapeId;
    assert.equal(state(shapeId).type, type);
    run(`window.__kan.editor.zoomToBounds(${JSON.stringify({ ...at, w: 650, h: 650 })}); return true;`);
    const child = type === "logo" ? '[data-testid="logo-body"]' : `[data-node-type="${type}"]`;
    await waitFor(`!!document.querySelector(${JSON.stringify(selector(shapeId, child))})`);
    if (type === "chart") {
      click(shapeId, '[data-testid="legend-requests"]');
      assert.deepEqual(state(shapeId).props.hiddenSeries, ["requests"]);
    }
    if (type === "table") {
      click(shapeId, '[data-testid="table-sort-0"]');
      click(shapeId, '[data-testid="table-row-1"]');
      assert.deepEqual(state(shapeId).props.sortBy, { column: 0, dir: "asc" });
      assert.deepEqual(state(shapeId).props.selectedRows, [1]);
    }
    if (type === "image") {
      await waitFor(`(() => { const img = document.querySelector(${JSON.stringify(selector(shapeId, "img"))}); return img?.complete && img.naturalWidth > 0; })()`);
    }
    if (type === "map") {
      await waitFor(`!!document.querySelector(${JSON.stringify(selector(shapeId, '[data-testid="map-marker-0"]'))})`);
      click(shapeId, '[data-testid="map-marker-0"]');
      assert.equal(state(shapeId).props.selectedMarker, 0);
    }
  }
  console.log("PASS all eight node types created and rendered through tools; chart, table, image, and map exercised");

  evaluate(`window.__kan.tools.updateNode(${JSON.stringify({ shapeId: ids.markdown, patch: { type: "markdown", title: "Tool-created note", body: "**Preserved after reload**" } })})`);
  evaluate(`window.__kan.tools.connectNodes(${JSON.stringify({ from: ids.markdown, to: ids.chart, label: "evidence" })})`);
  evaluate(`window.__kan.tools.arrange(${JSON.stringify({ shapeIds: created, layout: "grid" })})`);
  assert.ok(evaluate("window.__kan.tools.getCanvas().connections").some(({ from, to }) => from === ids.markdown && to === ids.chart));
  run(`window.__kan.editor.select(${JSON.stringify(ids.markdown)}); return true;`);
  await waitFor("document.querySelector('aside[aria-label=\"Thread\"]')?.textContent.includes('Tool-created note')");
  assert.deepEqual(evaluate("window.__kanErrors"), []);
  await pause(1500);
  drive("reload");
  await waitFor("!!window.__kan");
  assert.equal(state(ids.markdown).props.title, "Tool-created note");
  assert.equal(evaluate("window.__kan.tools.getCanvas().nodes.length"), 8);
  assert.deepEqual(evaluate("window.__kanErrors"), []);
  console.log("PASS update, connect, arrange, thread selection label, offline persistence, and no runtime errors");
  execFileSync(process.execPath, [fileURLToPath(new URL("./date-nodes.e2e.mjs", import.meta.url))], { stdio: "inherit", timeout: 120000 });
} finally {
  if (evaluate("location.pathname") === path) {
    await waitFor("!!window.__kan");
    if (created.length) evaluate(`window.__kan.tools.removeNodes(${JSON.stringify({ shapeIds: created })})`);
    assert.deepEqual(evaluate("window.__kan.editor.getCurrentPageShapes()"), []);
    await pause(1500);
  }
  await catalog("deleteCanvasEntry", canvasId);
  run(`location.assign(${JSON.stringify(originalPath)}); return true;`);
  await waitFor(`location.pathname === ${JSON.stringify(originalPath)} && ${originalHasEditor ? "!!window.__kan" : "!!document.querySelector('#root')"}`);
}
console.log("PASS test canvas cleaned up and original page restored");
