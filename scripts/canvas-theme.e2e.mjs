import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./drive.mjs", import.meta.url));
const drive = (...args) => {
  const output = execFileSync(process.execPath, [driver, ...args], { encoding: "utf8", timeout: 15000 });
  return args[0] === "shot" ? output.trim() : JSON.parse(output);
};
const evaluate = (expression) => drive("eval", `({result: (${expression})})`).result;
const run = (body) => evaluate(`(() => { ${body} })()`);
const waitFor = async (expression) => {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (evaluate(expression)) return;
    await pause(150);
  }
  throw new Error(`Timed out: ${expression}`);
};
const style = (selector, property, pseudo = null) => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}), ${JSON.stringify(pseudo)})[${JSON.stringify(property)}]`);
const catalog = async (method, args) => {
  run(`window.__themeCatalog = null; import('/src/lib/canvas-repository.ts').then(repo => repo[${JSON.stringify(method)}](${JSON.stringify(args)})).then(() => {window.__themeCatalog = {ok:true};}).catch(error => {window.__themeCatalog = {error:String(error)};}); return true;`);
  await waitFor("window.__themeCatalog !== null");
  assert.equal(evaluate("window.__themeCatalog.ok"), true, evaluate("window.__themeCatalog.error"));
};
const originalPath = evaluate("location.pathname + location.search + location.hash");
const originalHasEditor = evaluate("!!window.__kan");
const canvasId = randomUUID();
const path = `/canvas/${canvasId}`;
const active = '.kan-toolbar .tlui-button[aria-pressed="true"]';
let created = false;
let originalDark;

try {
  assert.equal(evaluate("!!window.__TAURI_INTERNALS__"), true);
  await catalog("createOfflineCanvas", { id: canvasId, name: "E2E canvas theme" });
  created = true;
  run(`location.assign(${JSON.stringify(path)}); return true;`);
  await waitFor(`location.pathname === ${JSON.stringify(path)} && !!window.__kan && !!document.querySelector('.kan-toolbar')`);
  originalDark = evaluate("document.documentElement.classList.contains('dark')");
  const canvasTokens = evaluate("['--tl-font-sans','--tl-radius-2','--tl-color-selection-stroke'].map(key => getComputedStyle(document.querySelector('.tl-canvas')).getPropertyValue(key))");

  assert.equal(style(".kan-toolbar", "borderRadius"), "0px");
  assert.equal(style(active, "borderRadius", "::after"), "0px");
  assert.match(style(".kan-toolbar", "fontFamily"), /Inter/);
  assert.equal(style(".kan-style-panel__swatch", "borderRadius"), "999px");
  for (const dark of [false, true]) {
    run(`document.documentElement.classList.toggle('dark', ${dark}); return true;`);
    await pause(200);
    const matches = evaluate(`(() => {
      const toolbar = document.querySelector('.kan-toolbar');
      const button = document.querySelector(${JSON.stringify(active)});
      const probe = document.createElement('span'); toolbar.appendChild(probe);
      probe.style.backgroundColor = 'var(--primary)'; probe.style.color = 'var(--primary-foreground)';
      const selected = getComputedStyle(button, '::after').backgroundColor === getComputedStyle(probe).backgroundColor && getComputedStyle(button).color === getComputedStyle(probe).color;
      probe.style.backgroundColor = 'var(--popover)';
      const panel = getComputedStyle(toolbar).backgroundColor === getComputedStyle(probe).backgroundColor;
      probe.remove(); return {selected,panel};
    })()`);
    assert.deepEqual(matches, { selected: true, panel: true });
  }
  run(`document.documentElement.classList.toggle('dark', ${originalDark}); return true;`);
  assert.deepEqual(evaluate("['--tl-font-sans','--tl-radius-2','--tl-color-selection-stroke'].map(key => getComputedStyle(document.querySelector('.tl-canvas')).getPropertyValue(key))"), canvasTokens);
  console.log("PASS square toolbar and selected controls, shared font, light/dark tokens, circular swatch, unchanged canvas tokens");

  drive("click", '.kan-toolbar button[aria-label="More tools"]');
  await waitFor("!!document.querySelector('.kan-toolbar__overflow')");
  assert.equal(style(".tlui-popover__content", "borderRadius"), "0px");
  assert.equal(style(".kan-toolbar__overflow .tlui-button__tool", "borderRadius", "::after"), "0px");
  drive("click", '.kan-toolbar__overflow [data-testid="tools.rectangle"]');
  await waitFor("window.__kan.editor.getCurrentToolId() === 'geo'");
  drive("shot", "/tmp/kan-canvas-theme-tools.png");
  run("window.__kan.editor.menus.clearOpenMenus(); return true;");
  drive("click", '.kan-toolbar button[aria-label="Color and style"]');
  await waitFor("!!document.querySelector('.tlui-style-panel')");
  assert.equal(style(".tlui-popover__content", "borderRadius"), "0px");
  drive("shot", "/tmp/kan-canvas-theme-style.png");
  run("window.__kan.editor.menus.clearOpenMenus(); return true;");
  drive("click", '.kan-toolbar [data-testid="tools.select"]');
  await waitFor("window.__kan.editor.getCurrentToolId() === 'select'");
  console.log("PASS more-tools and style popovers, rectangle/select tool switching");

  run("const el=document.querySelector('.tl-canvas'); const rect=el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:rect.x+160,clientY:rect.y+160})); return true;");
  await waitFor("!!document.querySelector('.tlui-menu')");
  assert.equal(style(".tlui-menu", "borderRadius"), "0px");
  assert.match(style(".tlui-menu", "fontFamily"), /Inter/);
  drive("shot", "/tmp/kan-canvas-theme-menu.png");
  run("window.__kan.editor.menus.clearOpenMenus(); return true;");
  assert.deepEqual(evaluate("window.__kanErrors"), []);
  assert.deepEqual(evaluate("window.__kan.editor.getCurrentPageShapes()"), []);
  drive("shot", "/tmp/kan-canvas-theme.png");
  console.log("PASS context menu and no runtime errors or canvas mutations");

  run("document.querySelector('.kan-toolbar [data-testid=\"tools.hand\"]').focus(); return true;");
  await waitFor("!!document.querySelector('.tlui-tooltip')");
  assert.equal(style(".tlui-tooltip", "borderRadius"), "0px");
  assert.match(style(".tlui-tooltip", "fontFamily"), /Inter/);
  run("document.activeElement.blur(); document.querySelector('.canvas__viewport').style.width='320px'; return true;");
  await waitFor("document.querySelector('.tl-container').getBoundingClientRect().width === 320");
  await pause(300);
  assert.equal(evaluate("(() => {const c=document.querySelector('.tl-container').getBoundingClientRect(); return [...document.querySelectorAll('.kan-toolbar button')].every(b=>{const r=b.getBoundingClientRect();return r.width>0 && r.left>=c.left && r.right<=c.right && r.bottom<=c.bottom;});})()"), true);
  drive("click", '.kan-toolbar button[aria-label="More tools"]');
  await waitFor("!!document.querySelector('.kan-toolbar__overflow')");
  assert.equal(style(".tlui-popover__content", "borderRadius"), "0px");
  drive("shot", "/tmp/kan-canvas-theme-narrow.png");
  run("window.__kan.editor.menus.clearOpenMenus(); document.querySelector('.canvas__viewport').style.removeProperty('width'); return true;");
  console.log("PASS tooltip and wrapped toolbar/popover at 320px canvas width");
} finally {
  if (evaluate("location.pathname") === path && originalDark !== undefined) {
    run(`document.documentElement.classList.toggle('dark', ${originalDark}); return true;`);
  }
  run(`location.assign(${JSON.stringify(originalPath)}); return true;`);
  await waitFor(`location.pathname + location.search + location.hash === ${JSON.stringify(originalPath)} && ${originalHasEditor ? "!!window.__kan" : "!window.__kan"}`);
  if (created) await catalog("deleteCanvasEntry", canvasId);
}
