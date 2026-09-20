import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./drive.mjs", import.meta.url));
const live = process.argv.includes("--live");
const drive = (...args) => {
  const output = execFileSync(process.execPath, [driver, ...args], { encoding: "utf8", timeout: 15000 });
  return ["fill", "shot", "reload"].includes(args[0]) ? output.trim() : JSON.parse(output);
};
const evaluate = expression => drive("eval", `({result:(${expression})})`).result;
const run = body => evaluate(`(()=>{${body}})()`);
async function waitFor(expression, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const error = evaluate("window.__drawingTest?.error");
    if (error) throw new Error(error);
    if (evaluate(expression)) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${expression}; ${JSON.stringify(evaluate("({text:document.querySelector('#drawing-test')?.innerText,failures:window.__kanRunFailures})"))}`);
}
const diagram = { type: "diagram", nodes: [{ id: "pizza", label: "Pizza", group: "food" }, { id: "salad", label: "Salad", group: "food" }, { id: "fruit", label: "Fruit", group: "food" }], groups: [{ id: "food", label: "Food options" }], edges: [] };
const flow = { type: "diagram", nodes: [{ id: "a", label: "Request" }, { id: "b", label: "Approved?", geo: "diamond" }, { id: "c", label: "Ship" }, { id: "d", label: "Revise" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c", label: "Yes" }, { from: "b", to: "d", label: "No" }], direction: "right" };
async function ask(text, result) {
  run(`const t=window.__drawingTest;t.nextResult=${JSON.stringify(result)};t.finished=false;t.calls=0;t.started=performance.now();t.before=t.editor.getCurrentPageShapes().map(s=>s.id);return true;`);
  drive("fill", "#drawing-test textarea", text);
  drive("clickText", "Ask Kan");
  await waitFor("window.__drawingTest.finished && !window.__drawingTest.agent.busy && !document.querySelector('#drawing-test')?.innerText.includes('Working')", 180000);
  await pause(300);
  const state = evaluate("({calls:window.__drawingTest.calls,providerMs:window.__drawingTest.providerMs,elapsedMs:performance.now()-window.__drawingTest.started,failures:window.__kanRunFailures??[],shapes:window.__drawingTest.editor.getCurrentPageShapes().filter(s=>!window.__drawingTest.before.includes(s.id)).map(s=>({id:s.id,type:s.type,parentId:s.parentId,props:s.props})),raw:window.__drawingTest.raw})");
  assert.equal(state.calls, 1, "Exactly one provider request, no follow-up checks");
  assert.deepEqual(state.failures, []);
  assert.ok(state.raw && JSON.parse(state.raw).kind);
  return state;
}
try {
  assert.equal(evaluate("!!window.__TAURI_INTERNALS__"), true);
  assert.equal(evaluate("!!window.__kan"), false, "Start on the catalog, not a user canvas");
  run(`
    const t=window.__drawingTest={id:crypto.randomUUID(),fetch:window.fetch};
    const commands=Object.fromEntries(['agent_restore','agent_preferences','agent_prompt_structured'].map(cmd=>[window.__TAURI_INTERNALS__.convertFileSrc(cmd,'ipc'),cmd]));
    const reply=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}});
    window.fetch=async(url,options)=>{
      const command=commands[String(url)],args=command?JSON.parse(options.body):{};
      if(!${live}&&command==='agent_restore'&&args.canvasId===t.id)return reply({state:'ready',provider:'devin',agent:'Drawing fixture'});
      if(!${live}&&command==='agent_preferences')return reply({provider:null,mode:null,modelId:null,autoConnect:false});
      if(command==='agent_prompt_structured'){
        t.calls++;t.prompt=args.prompt;const start=performance.now();
        const response=${live}?await t.fetch.call(window,url,options):reply(JSON.stringify(t.nextResult));
        t.raw=await response.clone().json();t.providerMs=performance.now()-start;t.finished=true;return response;
      }
      return t.fetch.call(window,url,options);
    };
    Promise.all([fetch('/src/components/Canvas.tsx').then(r=>r.text()),fetch('/src/components/ChatPanel.tsx').then(r=>r.text()),fetch('/src/main.tsx').then(r=>r.text())]).then(([canvasSource,chatSource,mainSource])=>Promise.all([
      import(mainSource.match(/from "([^"]*react[.]js[^"]*)"/)[1]),import(mainSource.match(/from "([^"]*react-dom_client[.]js[^"]*)"/)[1]),
      import(chatSource.match(/from "([^"]*agent-context.tsx[^"]*)"/)[1]),import(canvasSource.match(/from "([^"]*canvas-context.tsx[^"]*)"/)[1]),
      import('/src/components/Canvas.tsx'),import('/src/components/ChatPanel.tsx'),import('/src/lib/canvas-repository.ts')
    ])).then(async([React,ReactDOM,agent,canvas,{Canvas},{ChatPanel},repo])=>{
      t.repo=repo;await repo.createOfflineCanvas({id:t.id,name:'Drawing verification fixture'});
      const h=(React.default??React).createElement;
      function Capture(){t.agent=agent.useAgent();return null;}
      t.host=document.createElement('div');t.host.id='drawing-test';t.host.style.cssText='position:fixed;inset:0 0 40px 0;z-index:9999;display:flex;background:white';document.body.appendChild(t.host);
      t.root=(ReactDOM.default??ReactDOM).createRoot(t.host);
      t.root.render(h(agent.AgentProvider,{canvasId:t.id},h(canvas.CanvasProvider,null,h(Capture),h('div',{style:{display:'flex',flex:1,minWidth:0,height:'100%'}},h(Canvas,{roomId:t.id})),h(ChatPanel,{roomId:t.id}))));
    }).catch(error=>{t.error=String(error)});return true;
  `);
  await waitFor("!!window.__kan && window.__drawingTest.agent?.status.state==='ready' && document.querySelector('#drawing-test textarea')?.disabled===false", 60000);
  run("window.__drawingTest.editor=window.__kan.editor;return true;");
  let state = await ask("Create a calendar for a party on September 22, 2026, and a Food options group with separate boxes for pizza, salad and fruit.", { kind: "act", text: "Added party calendar and food options.", sources: [], operations: [{ type: "add", draft: { type: "calendar", title: "Party", events: [{ id: "party", title: "Party", start: "2026-09-22" }] } }, diagram] });
  assert.equal(state.shapes.filter(s => s.type === "kan-calendar").length, 1);
  const frame = state.shapes.find(s => s.type === "frame");
  assert.ok(frame);
  assert.ok(state.shapes.filter(s => s.type === "geo" && s.parentId === frame.id).length >= 3);
  console.log(JSON.stringify({ scenario: "calendar and grouped food", live, providerMs: state.providerMs, visibleMs: state.elapsedMs, shapes: state.shapes.length }));
  run("window.__drawingTest.editor.zoomToFit();return true;");
  drive("shot", "/tmp/kan-drawing-food.png");
  state = await ask("Draw a flowchart: Request leads to Approved?; Yes leads to Ship, No leads to Revise. Use four nodes and three labeled connections.", { kind: "act", text: "Added approval flowchart.", sources: [], operations: [flow] });
  assert.equal(state.shapes.filter(s => s.type === "geo").length, 4);
  assert.equal(state.shapes.filter(s => s.type === "arrow").length, 3);
  console.log(JSON.stringify({ scenario: "four-node branching diagram", live, providerMs: state.providerMs, visibleMs: state.elapsedMs, shapes: state.shapes.length }));
  run("const t=window.__drawingTest;t.editor.zoomToBounds(t.editor.getShapePageBounds(t.editor.getCurrentPageShapes().filter(s=>!t.before.includes(s.id))[0]));t.editor.zoomToFit();return true;");
  drive("shot", "/tmp/kan-drawing-flow.png");
  state = await ask("let’s discuss the solar system", { kind: "reply", text: "The Sun and eight planets form the solar system. Which part interests you?", sources: [] });
  assert.equal(state.shapes.length, 0);
  assert.equal(JSON.parse(state.raw).kind, "reply");
  console.log(JSON.stringify({ scenario: "solar system discussion", live, providerMs: state.providerMs }));
  run("const t=window.__drawingTest;t.calls=0;t.finished=true;t.before=t.editor.getCurrentPageShapes().map(s=>s.id);t.started=performance.now();return true;");
  drive("fill", "#drawing-test textarea", "Draw a red box.");
  drive("clickText", "Ask Kan");
  await waitFor("window.__drawingTest.editor.getCurrentPageShapes().some(s=>!window.__drawingTest.before.includes(s.id)&&s.type==='geo'&&s.props.color==='red')");
  const directId = evaluate("window.__drawingTest.editor.getCurrentPageShapes().find(s=>!window.__drawingTest.before.includes(s.id)&&s.type==='geo').id");
  assert.equal(evaluate("window.__drawingTest.calls"), 0);
  run(`window.__drawingTest.editor.select(${JSON.stringify(directId)});window.__drawingTest.started=performance.now();return true;`);
  drive("fill", "#drawing-test textarea", "Make it blue.");
  drive("clickText", "Ask Kan");
  await waitFor(`window.__drawingTest.editor.getShape(${JSON.stringify(directId)}).props.color==='blue'`);
  assert.equal(evaluate("window.__drawingTest.calls"), 0);
  console.log(JSON.stringify({ scenario: "direct creation and recoloring", live, providerCalls: 0, observedMs: evaluate("performance.now()-window.__drawingTest.started") }));
  if (!live) {
    await ask("Update the selected box label to Mercury: 88 Earth days and make it grey.", { kind: "act", text: "Updated label and color.", sources: [], operations: [{ type: "label", shapeId: directId, text: "Mercury: 88 Earth days" }, { type: "style", shapeId: directId, color: "grey" }] });
    const updated = evaluate(`window.__drawingTest.editor.getShape(${JSON.stringify(directId)})`);
    assert.equal(updated.props.color, "grey");
    assert.match(JSON.stringify(updated.props.richText), /88 Earth days/);
  }
  assert.deepEqual(evaluate("window.__kanErrors??[]"), []);
} finally {
  run(`const t=window.__drawingTest;if(t){t.editor?.deleteShapes([...t.editor.getCurrentPageShapeIds()]);t.root?.unmount();t.host?.remove();window.fetch=t.fetch;localStorage.removeItem('kan-assistant:'+t.id);t.repo?.deleteCanvasEntry(t.id);delete window.__drawingTest;}return true;`);
}
