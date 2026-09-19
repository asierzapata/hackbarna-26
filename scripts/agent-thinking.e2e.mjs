import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./drive.mjs", import.meta.url));
const drive = (...args) => {
  const output = execFileSync(process.execPath, [driver, ...args], {
    encoding: "utf8",
    timeout: 15000,
  });
  return args[0] === "shot" ? output.trim() : JSON.parse(output);
};
const evaluate = (expression) =>
  drive("eval", `({result: (${expression})})`).result;
const run = (body) => evaluate(`(() => { ${body} })()`);
const waitFor = async (expression) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const error = evaluate("window.__thinkingTest?.error");
    assert.ok(!error, error);
    if (evaluate(expression)) return;
    await pause(100);
  }
  throw new Error(
    `Timed out: ${expression}; ${JSON.stringify(evaluate("({status:window.__thinkingTest?.agent?.status,editor:!!window.__kan,errors:window.__kanErrors,fixture:document.querySelector('#thinking-test')?.textContent?.slice(0,200)})"))}`,
  );
};
const targets = () =>
  evaluate(
    "Array.from(document.querySelectorAll('#thinking-test [data-thinking-shape]'), el => el.dataset.thinkingShape)",
  );
const start = async (ids) => {
  run(
    `const t = window.__thinkingTest; t.pending = null; t.done = false; t.agent.prompt('Controlled thinking test', {canvas:{id:t.id, shapeIds:${JSON.stringify(ids)}, execute:(name,input) => t.execute(t.tools,name,input)}}).then(() => {t.done = true;}, error => {t.turnError = String(error); t.done = true;}); return true;`,
  );
  await waitFor("!!window.__thinkingTest.pending");
};
const tool = async (name, input, extra = {}) => {
  run(
    `const t = window.__thinkingTest; t.response = null; t.invoke('plugin:event|emit', {event:'canvas:tool',payload:{requestId:crypto.randomUUID(),turnId:t.pending.turnId,canvasId:t.id,name:${JSON.stringify(name)},arguments:${JSON.stringify(input)},expiresAt:Date.now()+10000,...${JSON.stringify(extra)}}}); return true;`,
  );
  if (!Object.keys(extra).length)
    await waitFor("!!window.__thinkingTest.response");
  await pause(150);
};
const finish = async (failure = false) => {
  run(
    `const t = window.__thinkingTest; t.pending.${failure ? "reject(new Error('fixture failure'))" : "resolve('end_turn')"}; return true;`,
  );
  await waitFor(
    "window.__thinkingTest.done && !window.__thinkingTest.agent.busy",
  );
  assert.deepEqual(targets(), []);
};

try {
  assert.equal(evaluate("!!window.__TAURI_INTERNALS__"), true);
  assert.equal(
    evaluate("!!window.__kan"),
    false,
    "Run from the canvas catalog, not an active user canvas",
  );
  run(`
    const t = window.__thinkingTest = {id:'thinking-test-'+crypto.randomUUID()};
    t.invoke = window.__TAURI_INTERNALS__.invoke;
    t.fetch = window.fetch;
    t.matchMedia = window.matchMedia;
    t.motion = new EventTarget();
    t.motion.matches = false;
    window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? t.motion : t.matchMedia.call(window,query);
    const commands = Object.fromEntries(['agent_restore','agent_preferences','agent_prompt','agent_cancel','agent_canvas_result'].map(cmd => [window.__TAURI_INTERNALS__.convertFileSrc(cmd,'ipc'),cmd]));
    const reply = (value, failed = false) => new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json','Tauri-Response':failed ? 'error' : 'ok'}});
    window.fetch = (url, options) => {
      const command = commands[String(url)];
      const args = command ? JSON.parse(options.body) : {};
      if (command === 'agent_restore' && args.canvasId === t.id) return Promise.resolve(reply({state:'ready',provider:'devin'}));
      if (command === 'agent_preferences') return Promise.resolve(reply({provider:null,mode:null,modelId:null,autoConnect:false}));
      if (command === 'agent_prompt' && args.canvasId === t.id) return new Promise(resolve => {t.pending = {...args,resolve:value=>resolve(reply(value)),reject:error=>resolve(reply(error.message,true))};});
      if (command === 'agent_cancel' && args.turnId === t.pending?.turnId) {t.pending.resolve('cancelled'); return Promise.resolve(reply(null));}
      if (command === 'agent_canvas_result' && args.turnId === t.pending?.turnId) {t.response = args; return Promise.resolve(reply(null));}
      return t.fetch.call(window,url,options);
    };
    Promise.all([
      fetch('/src/components/Canvas.tsx').then(response => response.text()),
      fetch('/src/components/CanvasThinkingOverlay.tsx').then(response => response.text()),
    ]).then(([canvasSource,overlaySource]) => Promise.all([
      import('/node_modules/.vite/deps/react.js'),
      import('/node_modules/.vite/deps/react-dom_client.js'),
      import(overlaySource.match(/from "([^"]*agent-context.tsx[^"]*)"/)[1]),
      import(canvasSource.match(/from "([^"]*canvas-context.tsx[^"]*)"/)[1]),
      import('/src/components/Canvas.tsx'),
      import('/src/lib/canvas-agent.ts'),
    ])).then(([React,ReactDOM,agent,canvas,{Canvas},tools]) => {
      t.execute = tools.executeCanvasTool;
      const h = (React.default ?? React).createElement;
      function Capture() {t.agent = agent.useAgent(); return null;}
      t.host = document.createElement('div');
      t.host.id = 'thinking-test';
      t.host.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;background:white';
      document.body.appendChild(t.host);
      t.root = (ReactDOM.default ?? ReactDOM).createRoot(t.host);
      t.root.render(h(agent.AgentProvider,{canvasId:t.id},h(canvas.CanvasProvider,null,h(Capture),h(Canvas,{roomId:t.id}))));
    }).catch(error => {t.error = String(error);});
    return true;
  `);
  await waitFor(
    "!!window.__kan && window.__thinkingTest.agent?.status.state === 'ready'",
  );
  const ids = run(`
    const t = window.__thinkingTest;
    t.editor = window.__kan.editor;
    t.tools = window.__kan.tools;
    t.ids = [0,1].map(i => t.tools.addNode({draft:{type:'markdown',title:i ? 'Unrelated node' : 'Planning next steps',body:'Readable content stays interactive while the assistant considers this node.'},at:{x:100+i*430,y:120}}).shapeId);
    t.editor.zoomToFit();
    return t.ids;
  `);
  await pause(300);
  assert.deepEqual(targets(), []);
  await start([ids[0]]);
  assert.deepEqual(targets(), [ids[0]]);
  assert.equal(
    evaluate(
      "getComputedStyle(document.querySelector('[data-thinking-shape]')).pointerEvents",
    ),
    "none",
  );
  const firstFrame = evaluate(
    "document.querySelector('[data-thinking-shape] canvas').toDataURL()",
  );
  await pause(350);
  assert.notEqual(
    evaluate(
      "document.querySelector('[data-thinking-shape] canvas').toDataURL()",
    ),
    firstFrame,
  );
  assert.ok(
    evaluate(
      "(() => {const c=document.querySelector('[data-thinking-shape] canvas'); const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data; return pixels.some((v,i)=>i%4===3 && v>0 && v<150);})()",
    ),
  );
  console.log(
    "PASS selected node only, translucent blue pixels, autonomous animation, pointer passthrough",
  );

  run(
    `window.__thinkingTest.editor.select(${JSON.stringify(ids[1])}); return true;`,
  );
  await pause(150);
  assert.deepEqual(targets(), [ids[0]]);
  const beforePan = evaluate(
    "document.querySelector('[data-thinking-shape]').getBoundingClientRect().x",
  );
  run(
    "const e=window.__thinkingTest.editor; const c=e.getCamera(); e.setCamera({...c,x:c.x+35}); return true;",
  );
  await pause(150);
  assert.notEqual(
    evaluate(
      "document.querySelector('[data-thinking-shape]').getBoundingClientRect().x",
    ),
    beforePan,
  );
  assert.ok(
    evaluate(
      `(() => { const t=window.__thinkingTest; const e=t.editor; const b=e.getShapePageBounds(${JSON.stringify(ids[0])}); const p=e.pageToViewport(b); return Math.abs(parseFloat(document.querySelector('[data-thinking-shape]').style.left)-Math.max(-6,p.x-6))<1; })()`,
    ),
  );
  console.log(
    "PASS selection changes do not retarget the turn; overlay tracks the camera",
  );

  await tool(
    "updateNode",
    { shapeId: ids[1], patch: { type: "markdown", title: "Wrong turn" } },
    { turnId: "stale-turn" },
  );
  assert.deepEqual(targets(), [ids[0]]);
  await tool(
    "updateNode",
    { shapeId: ids[1], patch: { type: "markdown", title: "Wrong canvas" } },
    { canvasId: "other-canvas" },
  );
  assert.deepEqual(targets(), [ids[0]]);
  await tool("updateNode", {
    shapeId: ids[1],
    patch: { type: "markdown", title: "Now considering this node" },
  });
  assert.deepEqual(targets(), [ids[1]]);
  assert.equal(evaluate("window.__thinkingTest.response.error ?? null"), null);
  await tool("getCanvas", { scope: "full" });
  assert.deepEqual(targets(), [ids[1]]);
  console.log(
    "PASS native canvas events retarget only the active turn/canvas; broad reads do not highlight everything",
  );

  run(
    "const t=window.__thinkingTest; t.motion.matches=true; t.motion.dispatchEvent(new Event('change')); return true;",
  );
  await pause(100);
  const still = evaluate(
    "document.querySelector('[data-thinking-shape] canvas').toDataURL()",
  );
  await pause(350);
  assert.equal(
    evaluate(
      "document.querySelector('[data-thinking-shape] canvas').toDataURL()",
    ),
    still,
  );
  run(
    "const t=window.__thinkingTest; t.motion.matches=false; t.motion.dispatchEvent(new Event('change')); t.editor.selectNone(); const ctx=document.querySelector('[data-thinking-shape] canvas').getContext('2d'); const clear=ctx.clearRect.bind(ctx); t.draws=0; ctx.clearRect=(...args)=>{t.draws++; return clear(...args);}; return true;",
  );
  await pause(100);
  drive("shot", "/tmp/kan-thinking-effect.png");
  await finish();
  const draws = evaluate("window.__thinkingTest.draws");
  await pause(150);
  assert.equal(evaluate("window.__thinkingTest.draws"), draws);
  console.log(
    "PASS reduced-motion freezes the effect; completion removes it and stops drawing",
  );

  await start([]);
  assert.deepEqual(targets(), []);
  await tool("addNode", {
    draft: { type: "markdown", title: "Created by fixture", body: "New node" },
    near: { shapeId: ids[0] },
  });
  const created = evaluate("window.__thinkingTest.response.result.shapeId");
  run("window.__thinkingTest.editor.zoomToFit(); return true;");
  await pause(150);
  assert.deepEqual(targets(), [created]);
  await tool("removeNodes", { shapeIds: [created] });
  assert.deepEqual(targets(), []);
  await finish();
  console.log(
    "PASS newly created nodes get the effect; removed nodes clear it",
  );

  await start([ids[0]]);
  run("window.__thinkingTest.agent.cancel(); return true;");
  await waitFor("window.__thinkingTest.done");
  assert.deepEqual(targets(), []);
  await start([ids[0]]);
  await finish(true);
  assert.match(evaluate("window.__thinkingTest.turnError"), /fixture failure/);
  assert.deepEqual(evaluate("window.__kanErrors"), []);
  console.log(
    "PASS cancellation and failure clean up; no frontend runtime errors",
  );
} finally {
  run(`
    const t = window.__thinkingTest;
    if (t) {
      t.pending?.resolve('cleanup');
      if (t.editor) t.editor.deleteShapes([...t.editor.getCurrentPageShapeIds()]);
      t.root?.unmount();
      t.host?.remove();
      window.fetch = t.fetch;
      window.matchMedia = t.matchMedia;
      delete window.__thinkingTest;
    }
    return true;
  `);
}
