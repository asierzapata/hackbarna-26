import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";

const driver = fileURLToPath(new URL("./drive.mjs", import.meta.url));
const drive = (...args) => {
  const output = execFileSync(process.execPath, [driver, ...args], { encoding: "utf8", timeout: 15000 });
  return ["fill", "shot", "reload"].includes(args[0]) ? output.trim() : JSON.parse(output);
};
const evaluate = (expression) => drive("eval", `({result:(${expression})})`).result;
const run = (body) => evaluate(`(()=>{${body}})()`);
async function waitFor(expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const error = evaluate("window.__diagFixture?.error");
    if (error) throw new Error(error);
    if (evaluate(expression)) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${expression}; ${JSON.stringify(evaluate("({text:document.body.innerText.slice(-1000),fixture:window.__diagFixture?{keys:Object.keys(window.__diagFixture),status:window.__diagFixture.agent?.status,error:window.__diagFixture.error}:null,errors:window.__kanErrors})"))}`);
}
async function invoke(command, args = {}) {
  run(`window.__diagReply=null;window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)}).then(value=>window.__diagReply={value},error=>window.__diagReply={error});return true;`);
  await waitFor("window.__diagReply !== null");
  const response = evaluate("window.__diagReply");
  if (response.error) throw new Error(JSON.stringify(response.error));
  return response.value;
}
const canvasId = randomUUID();
const originalPath = evaluate("location.pathname");
const turns = [];
async function send(scenario, expectedCode, timeout = 15000) {
  const before = evaluate("Array.from(document.querySelectorAll('[data-agent-diagnostics]'),e=>e.dataset.agentDiagnostics)");
  drive("fill", "aside[aria-label=Thread] textarea", `[diag:${scenario}]`);
  run("document.querySelector('aside[aria-label=Thread] textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true;");
  await waitFor(`Array.from(document.querySelectorAll('[data-agent-diagnostics]'),e=>e.dataset.agentDiagnostics).some(id=>id!=='all'&&!${JSON.stringify(before)}.includes(id))`);
  const id = evaluate(`Array.from(document.querySelectorAll('[data-agent-diagnostics]'),e=>e.dataset.agentDiagnostics).find(id=>id!=='all'&&!${JSON.stringify(before)}.includes(id))`);
  turns.push(id);
  const deadline = Date.now() + timeout;
  let data;
  do {
    data = await invoke("agent_diagnostics", { turnId: id });
    if (data.events.some((event) => ["prompt.completed", "prompt.completed_with_tool_errors", "prompt.failed", "prompt.cancelled"].includes(event.event))) break;
    await pause(100);
  } while (Date.now() < deadline);
  assert.ok(data.events.some((event) => event.event.startsWith("prompt.") && event.event !== "prompt.started"), `${scenario} did not terminate`);
  if (expectedCode) assert.ok(data.events.some((event) => event.failure?.code === expectedCode), `${scenario}: missing ${expectedCode}: ${JSON.stringify(data.events)}`);
  assert.ok(!JSON.stringify(data).includes(`[diag:${scenario}]`), "Prompts must not enter diagnostic logs");
  return { id, ...data };
}
const shapeCount = () => evaluate("window.__kan.editor.getCurrentPageShapes().length");
async function reload() {
  await pause(700);
  run("window.__diagFixture.agent.signIn('devin','subscription');return true;");
  await waitFor("window.__diagFixture.agent.status.state==='ready'", 30000);
}
function intercept(mode) {
  run(`
    window.__diagFetch=window.fetch;
    window.__diagFault=${JSON.stringify(mode)};
    const url=window.__TAURI_INTERNALS__.convertFileSrc('agent_canvas_result','ipc');
    window.fetch=(input,options)=>{
      if(String(input)!==url)return window.__diagFetch.call(window,input,options);
      if(window.__diagFault==='oversized'){
        const args=JSON.parse(options.body);args.result='x'.repeat(2*1024*1024);
        return window.__diagFetch.call(window,input,{...options,body:JSON.stringify(args)});
      }
      if(window.__diagFault==='delivery')return Promise.resolve(new Response(JSON.stringify({code:'RESULT_DELIVERY_FAILED',phase:'delivery',outcome:'unknown'}),{headers:{'Content-Type':'application/json','Tauri-Response':'error'}}));
      if(window.__diagFault==='timeout')return new Promise(resolve=>setTimeout(()=>resolve(window.__diagFetch.call(window,input,options)),22000));
      return window.__diagFetch.call(window,input,options);
    };return true;
  `);
}
function restoreFetch() { run("if(window.__diagFetch){window.fetch=window.__diagFetch;}return true;"); }
try {
  assert.equal(evaluate("!!window.__TAURI_INTERNALS__"), true);
  assert.notEqual(originalPath, "/onboarding", "Complete onboarding in the isolated fixture app first");
  run(`window.__diagSetup=null;import('/src/lib/canvas-repository.ts').then(repo=>repo.createOfflineCanvas({id:${JSON.stringify(canvasId)},name:'Agent diagnostics regression'})).then(()=>window.__diagSetup=true);return true;`);
  await waitFor("window.__diagSetup===true");
  run("location.assign('/');return true;");
  await pause(1000);
  await waitFor("location.pathname==='/' && !window.__kan && document.body.innerText.includes('Canvases')");
  run(`
    const t=window.__diagFixture={id:${JSON.stringify(canvasId)}};
    Promise.all([fetch('/src/components/Canvas.tsx').then(r=>r.text()),fetch('/src/components/CanvasThinkingOverlay.tsx').then(r=>r.text()),fetch('/src/main.tsx').then(r=>r.text())]).then(([canvasSource,overlaySource,mainSource])=>Promise.all([
      import(mainSource.match(/from "([^"]*react[.]js[^"]*)"/)[1]),import(mainSource.match(/from "([^"]*react-dom_client[.]js[^"]*)"/)[1]),
      import(overlaySource.match(/from "([^"]*agent-context.tsx[^"]*)"/)[1]),
      import(canvasSource.match(/from "([^"]*canvas-context.tsx[^"]*)"/)[1]),
      import('/src/components/Canvas.tsx'),import('/src/components/thread/ThreadPanel.tsx'),
      import('/src/lib/canvas-agent.ts'),import('/src/nodes/tools.ts')
    ])).then(([React,ReactDOM,agent,canvas,{Canvas},{ThreadPanel},tools,nodeTools])=>{
      const R=React.default??React,h=R.createElement;
      function Fixture(){
        t.agent=agent.useAgent();const {editor}=canvas.useCanvas();
        const [entries,setEntries]=R.useState([]);
        const patch=(id,fn)=>setEntries(previous=>previous.map(entry=>entry.id===id?fn(entry):entry));
        t.start=async text=>{
          const id=crypto.randomUUID();setEntries(previous=>[...previous,{id,seq:previous.length+1,at:new Date().toISOString(),kind:'agent',authorId:'fixture',text:''}]);
          try {await t.agent.prompt(text,{onTrace:traceId=>patch(id,entry=>({...entry,traceId})),onText:text=>patch(id,entry=>({...entry,text:entry.text+text})),canvas:{id:t.id,execute:async(name,input,guard)=>{
            if(t.delay){t.delayed=true;await new Promise(resolve=>t.release=resolve);}
            return tools.executeCanvasTool(nodeTools.createCanvasTools(editor,guard),name,input);
          }}});patch(id,entry=>({...entry,status:'done'}));}
          catch(error){patch(id,entry=>({...entry,status:error.name==='AbortError'?'cancelled':'failed',text:error.message}));}
        };
        return h('div',{style:{display:'flex',height:'100%',width:'100%'}},h('div',{style:{flex:1,minWidth:0,display:'flex',height:'100%'}},h(Canvas,{roomId:t.id})),h('div',{style:{width:480,height:'100%'}},h(ThreadPanel,{channel:'diagnostics fixture',entries,participants:[{id:'fixture',name:'Diagnostic agent',kind:'agent'}],currentUserId:'qa',composer:{onSend:({text})=>void t.start(text),disabled:t.agent.busy,agentReady:t.agent.status.state==='ready'}})));
      }
      t.host=document.createElement('div');t.host.id='diagnostics-fixture';t.host.style.cssText='position:fixed;inset:0 0 48px 0;z-index:10;background:white';document.body.appendChild(t.host);
      t.root=(ReactDOM.default??ReactDOM).createRoot(t.host);
      t.root.render(h(agent.AgentProvider,{canvasId:t.id},h(canvas.CanvasProvider,null,h(Fixture))));
    }).catch(error=>{t.error=String(error);});return true;
  `);
  await waitFor("!!window.__kan && window.__diagFixture.agent?.status.state==='ready'", 30000);
  const status = await invoke("agent_status", { canvasId });
  assert.equal(status.agent, "Diagnostics fixture", "Requires DEVIN_BIN=scripts/diagnostics-fake-agent.mjs; never run fault tests against a real provider");
  let before = shapeCount();
  const duplicate = await send("duplicate");
  assert.equal(shapeCount(), before + 1);
  assert.ok(duplicate.events.some((event) => event.event === "tool.deduplicated"));
  console.log("PASS real ACP -> MCP stdio -> loopback -> native IPC -> canvas, duplicate mutation creates one shape");

  before = shapeCount();
  const invalid = await send("invalid", "TOOL_VALIDATION_FAILED");
  assert.equal(shapeCount(), before);
  assert.ok(invalid.events.some((event) => event.failure?.issues?.some((issue) => issue.path.includes("start"))));
  drive("click", `[data-agent-diagnostics='${invalid.id}'] [data-slot=collapsible-trigger]`);
  await waitFor(`!!document.querySelector("[data-agent-diagnostics='${invalid.id}'] [data-failure-code=TOOL_VALIDATION_FAILED]")`);
  drive("shot", "/tmp/kan-agent-diagnostic-failure.png");
  console.log("PASS invalid tool arguments report schema field paths in expandable UI without mutating the canvas");

  before = shapeCount();
  await send("partial", "TARGET_NOT_FOUND");
  assert.equal(shapeCount(), before + 1);
  await send("conflict", "OPERATION_CONFLICT");
  assert.equal(shapeCount(), before + 2);
  await send("permission", "PERMISSION_DENIED");
  console.log("PASS partial success preserved, conflicting operation ID rejected, prohibited tools remain denied");

  await send("incomplete", "TURN_INCOMPLETE");
  await send("malformed");
  let all = await invoke("agent_diagnostics");
  assert.ok(all.events.some((event) => event.failure?.code === "PROTOCOL_INVALID"));
  console.log("PASS non-end-turn stop reason is a failure; malformed ACP protocol is recorded without losing the session");

  intercept("oversized");
  await send("oversized", "RESULT_TOO_LARGE");
  restoreFetch();
  console.log("PASS native oversized-result rejection reaches MCP immediately instead of becoming a timeout");

  intercept("timeout");
  const timeout = await send("timeout", "TOOL_TIMEOUT", 30000);
  assert.ok(timeout.events.some((event) => event.failure?.code === "TOOL_TIMEOUT" && event.failure.outcome === "unknown"));
  await pause(2500); restoreFetch();
  all = await invoke("agent_diagnostics", { turnId: timeout.id });
  assert.ok(all.events.some((event) => event.event === "tool.late_result"));
  console.log("PASS real bridge deadline reports unknown outcome and rejects a late native acknowledgement");

  intercept("delivery");
  await send("delivery", "RESULT_DELIVERY_FAILED");
  restoreFetch();
  await reload();
  console.log("PASS IPC delivery failure is visible immediately, cancels the turn, and the app reconnects");

  await invoke("agent_diagnostics_capture", { enabled: true });
  await send("exit", "AGENT_EXITED");
  const details = await invoke("agent_diagnostics_details");
  assert.ok(JSON.stringify(details).includes("provider exited"));
  assert.ok(!JSON.stringify(details).includes("fixture-secret-never-export"));
  await invoke("agent_diagnostics_capture", { enabled: false });
  assert.deepEqual((await invoke("agent_diagnostics_details")).stderr, []);
  await reload();
  console.log("PASS provider exit is classified, stderr is drained and redacted, opt-in capture clears when disabled");

  before = shapeCount();
  run("const t=window.__diagFixture;t.delay=true;t.delayed=false;t.start('[diag:mermaid]');return true;");
  await waitFor("window.__diagFixture.delayed===true");
  run("window.__diagFixture.agent.cancel();return true;");
  await waitFor("!window.__diagFixture.agent.busy");
  run("const t=window.__diagFixture;t.delay=false;t.release();return true;");
  await pause(700);
  assert.equal(shapeCount(), before);
  all = await invoke("agent_diagnostics");
  assert.ok(all.events.some((event) => event.event === "prompt.cancelled"));
  await reload();
  await send("mermaid");
  assert.ok(shapeCount() > before);
  console.log("PASS cancelled asynchronous work cannot mutate later; active Mermaid still renders through the guarded editor");

  run("window.__diagStructured=null;window.__diagFixture.agent.runStructured('act',{},new AbortController().signal).then(value=>window.__diagStructured={value},error=>window.__diagStructured={code:error.failure?.code});return true;");
  await waitFor("window.__diagStructured !== null");
  assert.equal(evaluate("window.__diagStructured.code"), "STRUCTURED_OUTPUT_INVALID");
  console.log("PASS real isolated structured ACP path rejects malformed JSON with a distinct parse failure");

  drive("clickText", "Report bug");
  await waitFor("!!document.querySelector('#qa-description')");
  drive("fill", "#qa-description", "Diagnostics regression fixture; safe to remove with this isolated QA directory.");
  drive("click", "[data-agent-diagnostics=all] button");
  await waitFor("!!document.querySelector('#diagnostic-preview-all')?.value");
  const preview = evaluate("document.querySelector('#diagnostic-preview-all').value");
  assert.ok(JSON.parse(preview).events.length > 0);
  assert.ok(!preview.includes("fixture-secret-never-export"));
  assert.ok(evaluate("(()=>{const d=document.querySelector('#diagnostic-preview-all').closest('[role=dialog]').getBoundingClientRect();return d.top>=0&&d.bottom<=innerHeight&&d.height>200;})()"), "Diagnostic dialog must fit the native window");
  drive("clickText", "Copy diagnostics");
  await waitFor("document.body.innerText.includes('Copied') || document.body.innerText.includes('Clipboard unavailable')");
  assert.ok(evaluate("document.body.innerText.includes('Copied')"), "Native clipboard copy should succeed");
  drive("shot", "/tmp/kan-agent-diagnostics-preview.png");
  run("const dialog=document.querySelector('#diagnostic-preview-all').closest('[role=dialog]');Array.from(dialog.querySelectorAll('button')).find(button=>button.textContent.trim()==='Close').click();return true;");
  await waitFor("!document.querySelector('#diagnostic-preview-all') && !!document.querySelector('#qa-description')");
  drive("clickText", "Save report");
  await waitFor("!!document.querySelector('[data-qa-report-id]')");
  const reportPath = evaluate("document.querySelector('[data-qa-report-id]').textContent.replace('Saved to ','').trim()");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.ok(report.diagnostics.events.some((event) => event.failure));
  const diagnostics = await invoke("agent_diagnostics");
  const log = await readFile(diagnostics.directory + "/events.jsonl", "utf8");
  assert.ok(log.includes("TOOL_VALIDATION_FAILED"));
  assert.ok(!log.includes("fixture-secret-never-export") && !log.includes("Invalid fixture"));
  assert.equal((await stat(diagnostics.directory + "/events.jsonl")).mode & 0o777, 0o600);
  drive("clickText", "Done");
  assert.deepEqual(evaluate("window.__kanErrors"), []);
  console.log("PASS preview and clipboard export, immutable QA report with trace, private content-free native log, no frontend runtime errors");
  console.log(JSON.stringify({ reportPath, logDirectory: diagnostics.directory, turns: turns.length }));
} finally {
  restoreFetch();
  run(`const t=window.__diagFixture;if(t?.id===${JSON.stringify(canvasId)}){t.release?.();if(window.__kan)window.__kan.editor.deleteShapes([...window.__kan.editor.getCurrentPageShapeIds()]);t.root?.unmount();t.host?.remove();}location.assign(${JSON.stringify(originalPath)});return true;`);
  await pause(1000);
  run(`import('/src/lib/canvas-repository.ts').then(repo=>repo.deleteCanvasEntry(${JSON.stringify(canvasId)}));return true;`);
}
