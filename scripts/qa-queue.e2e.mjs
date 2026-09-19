import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./drive.mjs", import.meta.url));
const drive = (...args) => {
  const output = execFileSync(process.execPath, [driver, ...args], { encoding: "utf8", timeout: 15000 });
  return ["fill", "shot"].includes(args[0]) ? output.trim() : JSON.parse(output);
};
const evaluate = (expression) => drive("eval", `({result:(${expression})})`).result;
const run = (body) => evaluate(`(() => {${body}})()`);
const waitFor = async (expression) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    assert.ok(!evaluate("window.__queueTest?.error"), evaluate("window.__queueTest?.error"));
    if (evaluate(expression)) return;
    await pause(150);
  }
  throw new Error(`Timed out: ${expression}; ${evaluate("document.querySelector('#queue-test')?.innerText")}`);
};
const ask = async (text, result) => {
  run(`window.__queueTest.nextResult=${JSON.stringify(result)}; window.__queueTest.prompt=null; return true;`);
  drive("fill", "#queue-test textarea", text);
  drive("clickText", "Ask Kan");
  await waitFor("!!window.__queueTest.prompt && !window.__queueTest.agent.busy");
};

try {
  assert.equal(evaluate("!!window.__TAURI_INTERNALS__"), true);
  assert.equal(evaluate("!!window.__kan"), false, "Run from catalog/onboarding, not a user canvas");
  run(`
    const t=window.__queueTest={id:crypto.randomUUID(),fetch:window.fetch};
    const commands=Object.fromEntries(['agent_restore','agent_preferences','agent_prompt_structured'].map(cmd=>[window.__TAURI_INTERNALS__.convertFileSrc(cmd,'ipc'),cmd]));
    const reply=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}});
    window.fetch=(url,options)=>{
      const command=commands[String(url)],args=command?JSON.parse(options.body):{};
      if(command==='agent_restore'&&args.canvasId===t.id)return Promise.resolve(reply({state:'ready',provider:'devin',agent:'Regression agent'}));
      if(command==='agent_preferences')return Promise.resolve(reply({provider:null,mode:null,modelId:null,autoConnect:false}));
      if(command==='agent_prompt_structured'){t.prompt=args.prompt;return Promise.resolve(reply(JSON.stringify(t.nextResult)));}
      return t.fetch.call(window,url,options);
    };
    Promise.all([fetch('/src/components/Canvas.tsx').then(r=>r.text()),fetch('/src/components/ChatPanel.tsx').then(r=>r.text())]).then(([canvasSource,chatSource])=>Promise.all([
      import('/node_modules/.vite/deps/react.js'),import('/node_modules/.vite/deps/react-dom_client.js'),
      import(chatSource.match(/from "([^"]*agent-context.tsx[^"]*)"/)[1]),
      import(canvasSource.match(/from "([^"]*canvas-context.tsx[^"]*)"/)[1]),
      import('/src/components/Canvas.tsx'),import('/src/components/ChatPanel.tsx'),import('/src/lib/canvas-agent.ts')
    ])).then(([React,ReactDOM,agent,canvas,{Canvas},{ChatPanel},tools])=>{
      const h=(React.default??React).createElement;
      t.execute=tools.executeCanvasTool;
      function Capture(){t.agent=agent.useAgent();return null;}
      t.host=document.createElement('div'); t.host.id='queue-test';
      t.host.style.cssText='position:fixed;inset:0;z-index:9999;display:flex;background:white';
      document.body.appendChild(t.host);t.root=(ReactDOM.default??ReactDOM).createRoot(t.host);
      t.root.render(h(agent.AgentProvider,{canvasId:t.id},h(canvas.CanvasProvider,null,h(Capture),h('div',{style:{display:'flex',flexDirection:'column',flex:1,minWidth:0,height:'100%'}},h(Canvas,{roomId:t.id})),h(ChatPanel,{roomId:t.id,onClose:()=>{t.closed=true;}}))));
    }).catch(error=>{t.error=String(error);});
    return true;
  `);
  await waitFor("!!window.__kan && window.__queueTest.agent?.status.state==='ready' && document.querySelector('#queue-test textarea')?.disabled===false");
  assert.ok(evaluate("document.querySelector('#queue-test .canvas').getBoundingClientRect().height") > 500);
  const star = run("const t=window.__queueTest;t.editor=window.__kan.editor;t.tools=window.__kan.tools;t.star=t.tools.addNode({draft:{type:'geo',geo:'star'},at:{x:100,y:100}}).shapeId;return t.star;");
  run("const t=window.__queueTest;t.execute(t.tools,'updateNode',{shapeId:t.star,patch:{type:'geo',color:'blue'}});return true;");
  assert.equal(evaluate(`window.__kan.editor.getShape(${JSON.stringify(star)}).props.color`), "blue");
  run("const t=window.__queueTest;t.editor.updateShape({id:t.star,type:'geo',props:{color:'black'}});t.editor.select(t.star);return true;");
  await ask("make it blue", { kind: "act", text: "Changed the selected star to blue.", sources: [], operations: [{ type: "style", shapeId: star, color: "blue" }] });
  await waitFor(`window.__kan.editor.getShape(${JSON.stringify(star)}).props.color==='blue'`);
  assert.match(evaluate("window.__queueTest.prompt"), new RegExp(star));
  assert.equal(evaluate("window.__kan.editor.getCurrentPageShapes().length"), 1);
  assert.equal(evaluate(`window.__kan.editor.getShape(${JSON.stringify(star)}).props.geo`), "star");
  console.log("PASS star recoloring via validated canvas tool and actual Ask Kan / claimed structured completion flow");

  if (!process.argv.includes("--color-only")) {
    const tomorrow = evaluate("(() => { const date=new Date();date.setDate(date.getDate()+1);return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');})()");
    const draft = { type: "calendar", title: "Calendar", events: [], month: tomorrow.slice(0, 7), selectedDate: tomorrow };
    run("window.__kan.editor.selectNone(); return true;");
    await ask("Create a calendar with tomorrow selected", { kind: "act", text: "Created the calendar with tomorrow selected.", sources: [], operations: [{ type: "add", draft }] });
    await waitFor("window.__kan.editor.getCurrentPageShapes().some(shape=>shape.type==='kan-calendar')");
    const calendar = evaluate("window.__kan.editor.getCurrentPageShapes().find(shape=>shape.type==='kan-calendar')");
    assert.equal(calendar.props.selectedDate, tomorrow);
    assert.equal(calendar.props.month, tomorrow.slice(0, 7));
    assert.equal(evaluate("window.__kan.editor.getCurrentPageShapes().some(shape=>shape.type==='kan-node'||shape.type==='kan-table')"), false);
    assert.match(evaluate("window.__queueTest.prompt"), /never use a table to imitate a calendar/);
    run("window.__kan.editor.zoomToFit();return true;");
    await waitFor(`document.querySelector('[data-calendar-date="${tomorrow}"]')?.getAttribute('aria-pressed')==='true'`);
    drive("clickText", "Next month");
    await waitFor(`window.__kan.editor.getShape(${JSON.stringify(calendar.id)}).props.month!==${JSON.stringify(draft.month)}`);
    assert.equal(evaluate(`window.__kan.editor.getShape(${JSON.stringify(calendar.id)}).props.selectedDate`), null);
    drive("clickText", "Previous month");
    drive("click", `[data-calendar-date="${tomorrow}"]`);
    await waitFor(`window.__kan.editor.getShape(${JSON.stringify(calendar.id)}).props.selectedDate===${JSON.stringify(tomorrow)}`);
    console.log("PASS Ask Kan creates the rich calendar with tomorrow selected; month navigation and day selection work");

    run(`window.__kan.editor.createShape({id:'shape:shared-calendar-fixture',type:'kan-node',x:750,y:100,props:{w:520,h:560,draft:${JSON.stringify(draft)}}});window.__kan.editor.zoomToFit();return true;`);
    await waitFor("document.querySelectorAll('[data-calendar-month]').length===2");
    drive("click", '[data-shape-id="shape:shared-calendar-fixture"] [aria-label="Next month"]');
    await waitFor(`window.__kan.editor.getShape('shape:shared-calendar-fixture').props.draft.month!==${JSON.stringify(draft.month)}`);
    assert.equal(evaluate("window.__kan.editor.getShape('shape:shared-calendar-fixture').props.draft.selectedDate"), null);
    console.log("PASS shared wire calendar uses the same interactive rich renderer");
  }
  if (!process.argv.includes("--color-only") && !process.argv.includes("--calendar-only")) {
    assert.equal(evaluate("!!document.querySelector('#queue-test [aria-label=\"Copy thread link\"]')"), false);
    drive("clickText", "Close thread");
    assert.equal(evaluate("window.__queueTest.closed"), true);
    console.log("PASS thread link removed; Esc-labelled close control still works");
  }
  drive("shot", "/tmp/kan-queue-regressions.png");
  assert.deepEqual(evaluate("window.__kanErrors"), []);
} finally {
  run(`
    const t=window.__queueTest;
    if(t){
      if(t.editor)t.editor.deleteShapes([...t.editor.getCurrentPageShapeIds()]);
      t.root?.unmount();t.host?.remove();window.fetch=t.fetch;
      localStorage.removeItem('kan-assistant:'+t.id);
      delete window.__queueTest;
    }
    return true;
  `);
}
