import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./drive.mjs", import.meta.url));
const drive = (...args) => {
  const output = execFileSync(process.execPath, [driver, ...args], { encoding: "utf8", timeout: 15000 });
  return ["reload", "shot", "fill"].includes(args[0]) ? output.trim() : JSON.parse(output);
};
const evaluate = (expression) => drive("eval", `({result: (${expression})})`).result;
const run = (body) => evaluate(`(() => { ${body} })()`);
const waitFor = async (expression, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (evaluate(expression)) return;
    await pause(200);
  }
  throw new Error(`Timed out: ${expression}`);
};
const originalPath = evaluate("location.pathname");
const canvasId = randomUUID();
const path = `/canvas/${canvasId}`;
const catalog = async (method, input) => {
  run(`window.__chatCatalog = null; import('/src/lib/canvas-repository.ts').then(repo => repo[${JSON.stringify(method)}](${JSON.stringify(input)})).then(() => {window.__chatCatalog={ok:true};}).catch(error => {window.__chatCatalog={error:String(error)};}); return true;`);
  await waitFor("window.__chatCatalog !== null");
  assert.equal(evaluate("window.__chatCatalog.ok"), true, evaluate("window.__chatCatalog.error"));
};
const height = () => evaluate("document.querySelector('.canvas').getBoundingClientRect().height");
const chatWidth = () => evaluate("document.querySelector('aside[aria-label=Thread]').getBoundingClientRect().width");
const enter = () => run("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return true;");
const visibleToolbar = () => evaluate(`(() => {
  const toolbar = document.querySelector('.kan-toolbar');
  const canvas = document.querySelector('.canvas');
  if (!toolbar || !canvas) return false;
  const t = toolbar.getBoundingClientRect(), c = canvas.getBoundingClientRect();
  const hit = document.elementFromPoint(t.x+t.width/2,t.y+t.height/2);
  return t.width > 0 && t.height > 0 && t.top >= c.top && t.bottom <= c.bottom && toolbar.contains(hit);
})()`);

try {
  assert.equal(evaluate("!!window.__TAURI_INTERNALS__"), true);
  await catalog("createOfflineCanvas", { id: canvasId, name: "E2E canvas and chat regressions" });
  run(`location.assign(${JSON.stringify(path)}); return true;`);
  await waitFor("!!window.__kan && !!document.querySelector('aside[aria-label=Thread]')");
  assert.ok(height() > 500, `Canvas must fill the panel, got ${height()}px`);
  assert.ok(visibleToolbar(), "Canvas toolbar must be visible and hit-testable");
  console.log("PASS nonzero canvas height and visible, hit-testable toolbar");

  run("window.__chatEditor = window.__kan.editor; return true;");
  const beforeWidth = chatWidth();
  drive("drag", "[data-slot=resizable-handle]", -90, 0);
  await waitFor(`Math.abs(document.querySelector('aside[aria-label=Thread]').getBoundingClientRect().width-${beforeWidth}) > 30`);
  assert.ok(height() > 500);
  assert.ok(visibleToolbar());
  drive("fill", "textarea", "Keep this draft when chat reopens");
  drive("clickText", "Close thread");
  await waitFor("!!document.querySelector('.chat-reopen-button')");
  assert.equal(evaluate("window.__chatEditor === window.__kan.editor"), true, "Closing chat must not remount the canvas");
  assert.ok(height() > 500);
  assert.ok(visibleToolbar());
  drive("clickText", "Open chat");
  await waitFor("document.querySelector('textarea')?.getBoundingClientRect().width > 0");
  assert.equal(evaluate("window.__chatEditor === window.__kan.editor"), true);
  assert.equal(evaluate("document.querySelector('textarea').value"), "Keep this draft when chat reopens");
  assert.ok(Math.abs(chatWidth() - (beforeWidth + 90)) < 10, "Chat width should survive closing and reopening");
  console.log("PASS resize and close/reopen preserve canvas instance, toolbar, draft, and chat width");

  const box = evaluate("window.__kan.tools.addNode({draft:{type:'geo',geo:'rectangle',text:'hi'},at:{x:2400,y:1800}}).shapeId");
  const circle = evaluate(`window.__kan.tools.addNode({draft:{type:'geo',geo:'ellipse',text:'bye'},near:{shapeId:${JSON.stringify(box)}}}).shapeId`);
  const arrow = evaluate(`window.__kan.tools.connectNodes({from:${JSON.stringify(box)},to:${JSON.stringify(circle)}}).shapeId`);
  await pause(1200);
  const shapes = evaluate("window.__kan.editor.getCurrentPageShapes()");
  assert.equal(shapes.length, 3);
  assert.equal(shapes.find(({ id }) => id === box).type, "geo");
  const circleShape = shapes.find(({ id }) => id === circle);
  assert.equal(circleShape.type, "geo");
  assert.equal(circleShape.props.geo, "ellipse");
  assert.equal(circleShape.props.w, circleShape.props.h);
  evaluate(`window.__kan.tools.updateNode({shapeId:${JSON.stringify(box)},patch:{type:'geo',text:'hello'}})`);
  assert.equal(evaluate(`window.__kan.editor.getShapeUtil(window.__kan.editor.getShape(${JSON.stringify(box)})).getText(window.__kan.editor.getShape(${JSON.stringify(box)}))`), "hello");
  assert.equal(evaluate(`window.__kan.editor.getShape(${JSON.stringify(box)}).type`), "geo");
  assert.deepEqual(evaluate("window.__kan.tools.getCanvas().connections"), [{ id: arrow, from: box, to: circle, label: "" }]);
  console.log("PASS native rectangle/circle, bound arrow, and in-place text editing");

  run(`window.__kan.editor.select(${JSON.stringify(box)}); window.__kan.editor.setCamera({x:10000,y:10000,z:0.2}); return true;`);
  const documentBefore = evaluate("window.__kan.editor.getCurrentPageShapes()");
  const cameraBefore = evaluate("window.__kan.editor.getCamera()");
  evaluate(`window.__kan.tools.focusNodes({shapeIds:${JSON.stringify([box, circle])}})`);
  await waitFor(`(() => {const e=window.__kan.editor,v=e.getViewportPageBounds();return ${JSON.stringify([box, circle])}.every(id=>{const b=e.getShapePageBounds(id);return b.x>=v.x && b.y>=v.y && b.maxX<=v.maxX && b.maxY<=v.maxY;});})()`);
  await pause(200);
  assert.deepEqual(evaluate("window.__kan.editor.getCurrentPageShapes()"), documentBefore);
  assert.deepEqual(evaluate("window.__kan.editor.getSelectedShapeIds()"), [box]);
  assert.notDeepEqual(evaluate("window.__kan.editor.getCamera()"), cameraBefore, JSON.stringify(evaluate("({visibility:document.visibilityState,options:window.__kan.editor.getCameraOptions(),animation:window.__kan.editor._viewportAnimation,viewport:window.__kan.editor.getViewportScreenBounds()})")));
  assert.equal(evaluate(`(() => {const e=window.__kan.editor,v=e.getViewportPageBounds();return ${JSON.stringify([box, circle])}.every(id=>{const b=e.getShapePageBounds(id);return b.x>=v.x && b.y>=v.y && b.maxX<=v.maxX && b.maxY<=v.maxY;});})()`), true);
  const focusedCamera = evaluate("window.__kan.editor.getCamera()");
  assert.match(run("try {window.__kan.tools.focusNodes({shapeIds:['shape:missing-e2e']}); return 'no error';} catch(error) {return String(error);}"), /not found|missing/i);
  assert.deepEqual(evaluate("window.__kan.editor.getCamera()"), focusedCamera);
  console.log("PASS focus changes camera only, fits both shapes, and rejects missing shapes without moving the camera");

  run(`
    const t=window.__chatTest={fetch:window.fetch,pending:null};
    const command=window.__TAURI_INTERNALS__.convertFileSrc('agent_prompt','ipc');
    const reply=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}});
    window.fetch=(url,options)=>{
      if(String(url)===command){const args=JSON.parse(options.body);return new Promise(resolve=>{t.pending={...args,resolve:value=>resolve(reply(value))};});}
      return t.fetch.call(window,url,options);
    };
    return true;
  `);
  await waitFor("!!document.querySelector('[data-testid=agent-status]')", 120000);
  drive("fill", "textarea", "First regression message");
  enter();
  await waitFor("!!window.__chatTest.pending");
  assert.match(evaluate("document.querySelector('[data-slot=message-scroller-content]').textContent"), /working|thinking/i);
  run("const t=window.__chatTest;window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'agent:update',payload:{turnId:t.pending.turnId,update:{sessionUpdate:'agent_message_chunk',content:{text:'Updated the box.'}}}});return true;");
  await waitFor("document.querySelector('[data-slot=message-scroller-content]').textContent.includes('Updated the box.')");
  run("window.__chatTest.pending.resolve('end_turn');return true;");
  await waitFor("!document.querySelector('textarea').disabled");
  run("window.__chatTest.pending=null;return true;");
  drive("fill", "textarea", "Second regression message");
  enter();
  await waitFor("!!window.__chatTest.pending");
  const rows = evaluate("Array.from(document.querySelectorAll('[data-slot=message-scroller-item]'),el=>el.textContent)");
  assert.equal(rows.length, 4);
  assert.match(rows[0], /First regression message/);
  assert.match(rows[1], /Updated the box/);
  assert.match(rows[2], /Second regression message/);
  assert.match(rows[3], /working|thinking/i);
  assert.doesNotMatch(rows.join(" "), /via |tool_call|GPT-|duration/i);
  run("window.__chatTest.pending.resolve('end_turn');return true;");
  await waitFor("!document.querySelector('textarea').disabled");
  const buttons = evaluate("Array.from(document.querySelectorAll('aside[aria-label=Thread] button'),el=>(el.getAttribute('aria-label')||el.textContent||'').trim())");
  assert.ok(!buttons.some(label => /^(send|attach an image|start transcribing|stop transcribing)$/i.test(label)));
  assert.deepEqual(evaluate("window.__kanErrors"), []);
  drive("shot", "/tmp/kan-canvas-chat-fixed.png");
  console.log("PASS accessible pending feedback, Enter submission, chronological conversation, no action metadata or removed buttons, no frontend errors");

  if (process.argv.includes("--live")) {
    run(`
      window.fetch=window.__chatTest.fetch;
      window.__kan.editor.selectNone();
      window.__kan.editor.deleteShapes([...window.__kan.editor.getCurrentPageShapeIds()]);
      window.__liveCalls=[];
      import(${JSON.stringify(`/@fs${fileURLToPath(import.meta.resolve('@tauri-apps/api/event'))}`)}).then(({listen})=>listen('canvas:tool',({payload})=>window.__liveCalls.push({name:payload.name,input:payload.arguments}))).then(unlisten=>{window.__liveUnlisten=unlisten;});
      return true;
    `);
    await waitFor("!!window.__liveUnlisten");
    const sendLive = async (text) => {
      drive("fill", "textarea", text);
      enter();
      await waitFor("document.querySelector('textarea').disabled");
      await waitFor("!document.querySelector('textarea').disabled", 240000);
      const rows = evaluate("Array.from(document.querySelectorAll('[data-slot=message-scroller-item]'),el=>el.textContent)");
      assert.doesNotMatch(rows.at(-1), /could not complete/i);
      console.log(`LIVE ${text}\n${rows.at(-1)}`);
    };
    await sendLive("make a box that says hi. connect it to a circle that says bye with an arrow");
    const actual = evaluate("window.__kan.editor.getCurrentPageShapes()");
    assert.equal(actual.length, 3, "Expected only two native shapes and their arrow");
    const box = actual.find(shape => shape.type === "geo" && shape.props.geo === "rectangle");
    const circle = actual.find(shape => shape.type === "geo" && shape.props.geo === "ellipse");
    assert.ok(box && circle, "Live agent must create native shapes, not markdown/image substitutes");
    assert.equal(circle.props.w, circle.props.h);
    for (const [shape, label] of [[box, "hi"], [circle, "bye"]]) {
      assert.equal(evaluate(`window.__kan.editor.getShapeUtil(window.__kan.editor.getShape(${JSON.stringify(shape.id)})).getText(window.__kan.editor.getShape(${JSON.stringify(shape.id)}))`).trim().toLowerCase(), label);
    }
    assert.ok(evaluate("window.__kan.tools.getCanvas().connections").some(connection => connection.from === box.id && connection.to === circle.id));
    run("window.__kan.editor.setCamera({x:10000,y:10000,z:0.2});window.__liveCalls=[];return true;");
    const before = evaluate("window.__kan.editor.getCurrentPageShapes()");
    const camera = evaluate("window.__kan.editor.getCamera()");
    await sendLive("focus on it. i cant see it");
    await pause(1200);
    assert.ok(evaluate("window.__liveCalls.some(call=>call.name==='focusNodes')"), "Focus request must invoke the camera tool");
    assert.ok(!evaluate("window.__liveCalls.some(call=>call.name==='arrange')"));
    assert.deepEqual(evaluate("window.__kan.editor.getCurrentPageShapes()"), before);
    assert.notDeepEqual(evaluate("window.__kan.editor.getCamera()"), camera);
    assert.equal(evaluate(`(() => {const e=window.__kan.editor,v=e.getViewportPageBounds();return ${JSON.stringify([box.id, circle.id])}.every(id=>{const b=e.getShapePageBounds(id);return b.x>=v.x && b.y>=v.y && b.maxX<=v.maxX && b.maxY<=v.maxY;});})()`), true);
    await sendLive("also, i cant see the utility bar!");
    assert.ok(visibleToolbar());
    assert.deepEqual(evaluate("window.__kan.editor.getCurrentPageShapes()"), before);
    assert.deepEqual(evaluate("window.__kanErrors"), []);
    drive("shot", "/tmp/kan-live-canvas-chat-fixed.png");
    console.log("PASS exact live-agent prompts create native shapes, focus camera without moving content, and retain visible toolbar");
  }
} finally {
  if (evaluate("location.pathname") === path) {
    run("if(window.__chatTest){window.__chatTest.pending?.resolve('cleanup');window.fetch=window.__chatTest.fetch;delete window.__chatTest;} if(window.__kan)window.__kan.editor.deleteShapes([...window.__kan.editor.getCurrentPageShapeIds()]);return true;");
    await pause(1500);
  }
  await catalog("deleteCanvasEntry", canvasId);
  run(`location.assign(${JSON.stringify(originalPath)});return true;`);
  await waitFor(`location.pathname === ${JSON.stringify(originalPath)}`);
}
console.log("PASS isolated fixture cleaned up and original page restored");
