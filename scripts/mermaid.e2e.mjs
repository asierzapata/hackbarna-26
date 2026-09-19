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
const waitFor = async (expression, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (evaluate(expression)) return;
    await pause(250);
  }
  throw new Error(`Timed out: ${expression}`);
};
const originalPath = evaluate("location.pathname");
const canvasId = randomUUID();
const path = `/canvas/${canvasId}`;
const catalog = async (method, input) => {
  run(`window.__mermaidCatalog = null; import('/src/lib/canvas-repository.ts').then(repo => repo[${JSON.stringify(method)}](${JSON.stringify(input)})).then(() => { window.__mermaidCatalog = {ok:true}; }).catch(error => { window.__mermaidCatalog = {error:String(error)}; }); return true;`);
  await waitFor("window.__mermaidCatalog !== null");
  assert.equal(evaluate("window.__mermaidCatalog.ok"), true, evaluate("window.__mermaidCatalog.error"));
};

const agentSource = `flowchart TD
  Plan["HackBarna 26"] --> Dates["19–20 September"]
  Dates --> Venue["Norrsken House Barcelona"]
  Venue --> Build["Build weekend"]
  Sponsors["Vonage · Cognition · Nebius · Preply"] --> Build
  Build --> Demo["Demos + judging"]`;
const pasteSource = `Here is a diagram:\n\`\`\`mermaid\nflowchart LR\n  Input[Paste] --> Output[Native shapes]\n\`\`\``;

try {
  await catalog("createOfflineCanvas", { id: canvasId, name: "Mermaid verification" });
  run(`location.assign(${JSON.stringify(path)}); return true;`);
  await waitFor(`location.pathname === ${JSON.stringify(path)} && !!window.__kan`);
  assert.ok(evaluate("Object.keys(window.__kan.tools).includes('addMermaidDiagram')"));

  run(`window.__mermaidTool = null; window.__kan.tools.addMermaidDiagram(${JSON.stringify({
    source: agentSource,
    at: { x: 0, y: 0 },
    provenance: { entryId: "mermaid-e2e", runId: "mermaid-e2e", agentId: "assistant" },
  })}).then(value => { window.__mermaidTool = { value }; }).catch(error => { window.__mermaidTool = { error: String(error) }; }); return true;`);
  await waitFor("window.__mermaidTool !== null");
  assert.equal(evaluate("!!window.__mermaidTool.value"), true, evaluate("window.__mermaidTool.error"));
  const toolShapes = evaluate("window.__kan.tools.getCanvas({scope:'full'}).shapes");
  assert.ok(toolShapes.some(({ type }) => type === "group"));
  assert.ok(toolShapes.filter(({ type }) => type === "geo").length >= 6);
  assert.ok(evaluate("window.__kan.tools.getCanvas().connections.length >= 5"));
  const toolIds = evaluate("window.__mermaidTool.value.shapeIds");
  assert.ok(toolIds.every((id) => toolShapes.some((shape) => shape.id === id)));
  assert.equal(toolShapes.find(({ id }) => id === toolIds[0]).meta.provenance.agentId, "assistant");
  console.log("PASS agent Mermaid tool created editable boxes, arrows, group, and provenance");

  run(`window.__mermaidPaste = null; window.__kan.editor.putExternalContent({type:'text', text:${JSON.stringify(pasteSource)}, point:{x:1000,y:0}}).then(() => { window.__mermaidPaste = {ok:true}; }).catch(error => { window.__mermaidPaste = {error:String(error)}; }); return true;`);
  await waitFor("window.__mermaidPaste !== null");
  assert.equal(evaluate("window.__mermaidPaste.ok"), true, evaluate("window.__mermaidPaste.error"));
  await waitFor("window.__kan.tools.getCanvas({scope:'full'}).shapes.filter(({type}) => type === 'geo').length >= 8");
  assert.deepEqual(evaluate("window.__kan.editor.getSelectedShapeIds().length > 0"), true);
  assert.deepEqual(evaluate("window.__kanErrors"), []);
  drive("shot", "/tmp/kan-mermaid.png");
  console.log("PASS pasted Mermaid source became a second native diagram");
} finally {
  if (evaluate("location.pathname") === path) {
    const ids = evaluate("window.__kan?.editor.getCurrentPageShapeIds ? [...window.__kan.editor.getCurrentPageShapeIds()] : []");
    if (ids.length) evaluate(`window.__kan.tools.removeNodes(${JSON.stringify({ shapeIds: ids })})`);
    await pause(1000);
  }
  await catalog("deleteCanvasEntry", canvasId);
  run(`location.assign(${JSON.stringify(originalPath)}); return true;`);
  await waitFor(`location.pathname === ${JSON.stringify(originalPath)}`);
}
