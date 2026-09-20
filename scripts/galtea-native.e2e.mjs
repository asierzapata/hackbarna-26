import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { checkScenarioOutcome } from "./galtea-integrity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = `${root}galtea-results.local`;
const label = process.argv[2];
if (!label || !/^[a-z0-9-]+$/.test(label)) throw new Error("Provide a safe run label");
const filter = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined;
const replay = process.argv.includes("--replay");
const round2 = process.argv.includes("--round2");
const baselineModule = process.argv.includes("--baseline");
const repeats = process.argv.includes("--repeats");
const sourceModule = round2 ? `/@fs${directory}/round2-${baselineModule ? "before" : "after"}-canvas.ts` : baselineModule ? `/@fs${directory}/baseline-canvas.ts` : "/src/lib/assistant-canvas.ts";
const canvasModule = `${sourceModule}?galtea=${encodeURIComponent(label)}`;
const baselineRuns = replay ? JSON.parse(readFileSync(`${directory}/before-runs.json`, "utf8")) : [];
const allCases = JSON.parse(readFileSync(`${directory}/${round2 ? repeats ? "round2-repeat-cases" : "round2-cases" : "cases"}.json`, "utf8"));
const cases = filter ? allCases.filter(c => c.id === filter || c.suite === filter || c.key === filter || c.category === filter) : allCases;
assert.ok(cases.length, "No matching cases");
const outputPath = `${directory}/${label}-runs.json`;
const results = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, "utf8")) : [];
const drive = (...args) => {
  const output = execFileSync(process.execPath, [`${root}scripts/drive.mjs`, ...args], { encoding: "utf8", timeout: 15000 });
  return args[0] === "shot" ? output.trim() : JSON.parse(output);
};
const evaluate = expression => drive("eval", `({result:(${expression})})`).result;
const run = body => evaluate(`(()=>{${body}})()`);
async function waitFor(expression, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = evaluate(`({ready:!!(${expression}),error:window.__galteaNative?.error})`);
    if (state.error) throw new Error(state.error);
    if (state.ready) return;
    await pause(300);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function runRound2Case(testCase, model) {
  run(`
    const t=window.__galteaNative;t.finished=false;t.output=null;
    (async()=>{
      const c=${JSON.stringify(testCase)},f=c.fixture??{},editor=t.editor;
      editor.run(()=>editor.deleteShapes([...editor.getCurrentPageShapeIds()]),{ignoreShapeLock:true});
      const shapes=[
        {id:'shape:launch',type:'geo',x:100,y:100,isLocked:f.locked?.includes('shape:launch')??false,props:{geo:'rectangle',w:300,h:140,color:'red',richText:t.tldraw.toRichText(f.labels?.['shape:launch']??'Launch: awaiting approval')}},
        {id:'shape:notes',type:'kan-node',x:500,y:100,props:{w:340,h:240,draft:{type:'markdown',title:'Legal review',body:f.notesBody??'Legal approval is pending. Budget ceiling: EUR 5000. Do not alter this note unless explicitly asked.'}}}
      ];
      if(!f.original)shapes.push({id:'shape:budget',type:'geo',x:100,y:450,props:{geo:'rectangle',w:300,h:140,color:'yellow',richText:t.tldraw.toRichText(f.labels?.['shape:budget']??'Budget: EUR 5000')}},{id:'shape:existing-link',type:'arrow',x:250,y:240,props:{start:{x:0,y:0},end:{x:0,y:210},richText:t.tldraw.toRichText('budget context')}});
      editor.createShapes(shapes);
      if(editor.getCurrentPageShapes().length!==shapes.length)throw new Error('Fixture did not reset completely');
      for(const shape of shapes){const actual=editor.getShape(shape.id);if(!actual||actual.isLocked!==(shape.isLocked??false))throw new Error('Fixture lock or identity mismatch');}
      if(!f.original)editor.createBindings([{id:'binding:existing-start',type:'arrow',fromId:'shape:existing-link',toId:'shape:launch',props:{terminal:'start',normalizedAnchor:{x:0.5,y:0.5},isExact:false,isPrecise:false,snap:'none'}},{id:'binding:existing-end',type:'arrow',fromId:'shape:existing-link',toId:'shape:budget',props:{terminal:'end',normalizedAnchor:{x:0.5,y:0.5},isExact:false,isPrecise:false,snap:'none'}}]);
      editor.zoomToFit();
      const text=value=>!value||typeof value!=='object'?'':value.text??value.content?.map(text).filter(Boolean).join(' ')??'';
      const snapshot=()=>editor.getCurrentPageShapes().map(s=>({id:s.id,type:s.type,parentId:s.parentId,x:s.x,y:s.y,rotation:s.rotation,isLocked:s.isLocked,props:s.props,...(s.props.richText?{label:text(s.props.richText)}:{})}));
      const bindings=()=>Object.values(editor.getSnapshot().document.store).filter(r=>r.typeName==='binding');
      const output=t.output={runKey:c.key,testCaseId:c.id,category:c.category,attempt:c.attempt??1,fixture:f,turns:[],canvasExecutorSource:t.operations.applyAssistantOperations.toString(),startedAt:new Date().toISOString()};
      if(!t.originalFetch){
        t.originalFetch=window.fetch;const url=window.__TAURI_INTERNALS__.convertFileSrc('agent_prompt_structured','ipc');
        window.fetch=async(input,options)=>{const response=await t.originalFetch.call(window,input,options);if(String(input)===url)t.lastRaw=await response.clone().json();return response;};
      }
      let saved=[];
      const transport=t.transport.createLocalTransport({canvasId:t.id,userId:crypto.randomUUID(),storage:{async read(){return structuredClone(saved)},async write(_id,entries){saved=structuredClone(entries)}},getCanvas:()=>t.operations.assistantCanvasRecords(editor),applyOperations:(operations,provenance)=>t.operations.applyAssistantOperations(editor,operations,provenance)});
      const unsubscribe=transport.subscribe(()=>{});transport.setExecutorReady(true,'Galtea Round 2','own',false);
      try{
        for(const [index,step] of c.turns.entries()){
          const turn={index,prompt:step.prompt,expectation:step.expect,beforeCanvas:snapshot(),beforeBindings:bindings()};
          output.turns.push(turn);t.lastRaw=null;
          document.querySelector('#galtea-native-evidence').textContent=${JSON.stringify(label)}+'\\n'+c.key+'\\nTurn '+(index+1)+'/'+c.turns.length+'\\n\\n'+step.prompt;
          let lease,heartbeat;const start=performance.now();
          try{
            const messageId=crypto.randomUUID();
            await transport.send({id:messageId,text:'@kan '+step.prompt,anchors:step.anchors??[],files:[],source:'typed'});
            const trigger=transport.snapshot().triggers.find(trigger=>trigger.causeEntryIds.includes(messageId));
            lease=await transport.claimTrigger(trigger.id);
            const context=await transport.getLocalContext(lease.runId);
            turn.historyEntries=context.value.recentEntries.filter(e=>e.kind==='message'||e.kind==='agent_turn').map(e=>({kind:e.kind,text:e.text,status:e.status}));
            heartbeat=setInterval(()=>transport.heartbeatLocal(lease.runId).catch(()=>{}),10000);
            turn.proposedResult=await t.agent.runStructured('act',context.value,new AbortController().signal,step.anchors??[],lease.runId);
            await transport.completeLocal(lease.runId,{id:crypto.randomUUID(),revision:context.revision,result:turn.proposedResult});
            const entry=saved.find(e=>e.kind==='agent_turn'&&e.runId===lease.runId);turn.reply=entry?.text;turn.turnStatus=entry?.status;
          }catch(error){turn.applicationError=String(error);turn.failure=error.failure;if(lease)await transport.failLocal(lease.runId,'failed').catch(()=>{});}
          finally{clearInterval(heartbeat);}
          turn.rawResponse=t.lastRaw;turn.execution=t.lastRaw===null?'direct':'live-provider';turn.afterCanvas=snapshot();turn.afterBindings=bindings();turn.latencyMs=Math.round(performance.now()-start);
          document.querySelector('#galtea-native-evidence').textContent+='\\n\\n'+JSON.stringify({reply:turn.reply,proposed:turn.proposedResult,error:turn.applicationError},null,2);
        }
      }finally{unsubscribe();}
      editor.zoomToFit();t.finished=true;
    })().catch(error=>{t.error=String(error)});return true;
  `);
  await waitFor("window.__galteaNative?.finished && !window.__galteaNative.agent.busy", 210000 * testCase.turns.length);
  const result = { ...model, ...evaluate("window.__galteaNative.output") };
  result.canvasExecutorHash = createHash("sha256").update(result.canvasExecutorSource).digest("hex");
  if (results[0]?.canvasExecutorHash) assert.equal(result.canvasExecutorHash, results[0].canvasExecutorHash, "Executor changed within one evaluation version");
  writeFileSync(`${directory}/${label}-executor.js`, result.canvasExecutorSource);
  delete result.canvasExecutorSource;
  result.requestOutcome = checkScenarioOutcome(result);
  return result;
}

try {
  assert.equal(evaluate("!!window.__TAURI_INTERNALS__"), true);
  assert.equal(evaluate("!!window.__kan"), false, "Start on the catalog, not a user canvas");
  run(`
    const t=window.__galteaNative={id:crypto.randomUUID()};
    Promise.all([fetch('/src/components/Canvas.tsx').then(r=>r.text()),fetch('/src/components/ChatPanel.tsx').then(r=>r.text()),fetch('/src/main.tsx').then(r=>r.text())]).then(([canvasSource,chatSource,mainSource])=>Promise.all([
      import(mainSource.match(/from "([^"]*react[.]js[^"]*)"/)[1]),import(mainSource.match(/from "([^"]*react-dom_client[.]js[^"]*)"/)[1]),
      import(chatSource.match(/from "([^"]*agent-context.tsx[^"]*)"/)[1]),import(canvasSource.match(/from "([^"]*canvas-context.tsx[^"]*)"/)[1]),
      import('/src/components/Canvas.tsx'),import('/src/lib/canvas-repository.ts'),import('/src/lib/local-transport.ts'),import(${JSON.stringify(canvasModule)}),
      import(canvasSource.match(/from "([^"]*tldraw[.]js[^"]*)"/)[1])
    ])).then(async([React,ReactDOM,agent,canvas,{Canvas},repo,transport,operations,tldraw])=>{
      Object.assign(t,{repo,transport,operations,tldraw});
      await repo.createOfflineCanvas({id:t.id,name:'Galtea synthetic evaluation'});
      const h=(React.default??React).createElement;
      function Capture(){t.agent=agent.useAgent();return null;}
      t.host=document.createElement('div');t.host.id='galtea-native-test';t.host.style.cssText='position:fixed;inset:0 0 40px 0;z-index:9999;display:flex;background:white';document.body.appendChild(t.host);
      t.root=(ReactDOM.default??ReactDOM).createRoot(t.host);
      t.root.render(h(agent.AgentProvider,{canvasId:t.id},h(canvas.CanvasProvider,null,h(Capture),h('div',{style:{display:'flex',flex:1,minWidth:0,height:'100%'}},h(Canvas,{roomId:t.id})),h('pre',{id:'galtea-native-evidence',style:{width:400,padding:20,overflow:'auto',whiteSpace:'pre-wrap',fontSize:13,color:'#171717',background:'#f4f4f5'}},'Galtea: synthetic native evaluation'))));
    }).catch(error=>{t.error=String(error)});return true;
  `);
  await waitFor("!!window.__kan && window.__galteaNative.agent?.status.state==='ready'", 90000);
  const model = evaluate("({provider:window.__galteaNative.agent.status.provider,model:window.__galteaNative.agent.status.models?.current})");
  assert.equal(model.model, "gpt-5-6-luna-high", "Use the same model as the baseline");
  assert.equal(evaluate("window.__galteaNative.operations.applyAssistantOperations.toString().includes('puts.slice().reverse().find')"), !baselineModule && label !== "before", "Wrong canvas executor module; reload or use a fresh run label");
  run("window.__galteaNative.editor=window.__kan.editor;return true;");
  for (const testCase of cases) {
    if (results.some(result => round2 ? result.runKey === testCase.key : result.testCaseId === testCase.id)) continue;
    if (round2) {
      const result = await runRound2Case(testCase, model);
      results.push(result);
      writeFileSync(outputPath, JSON.stringify(results, null, 2));
      await pause(300);
      drive("shot", `${directory}/${label}-${testCase.key}.png`);
      console.log(JSON.stringify({ case: testCase.key, category: testCase.category, score: result.requestOutcome.score, turns: result.turns.length, errors: result.turns.filter(turn => turn.applicationError).map(turn => turn.failure ?? turn.applicationError), failures: result.requestOutcome.turns.flatMap(turn => turn.failures) }));
      continue;
    }
    const input = typeof testCase.input === "string" ? testCase.input : testCase.input?.user_message ?? JSON.stringify(testCase.input);
    assert.ok(input, "Generated case has no input");
    run(`
      const t=window.__galteaNative;t.finished=false;t.output=null;
      (async()=>{
        const editor=t.editor;editor.deleteShapes([...editor.getCurrentPageShapeIds()]);
        editor.createShapes([
          {id:'shape:launch',type:'geo',x:100,y:100,props:{geo:'rectangle',w:300,h:140,color:'red',richText:t.tldraw.toRichText('Launch: awaiting approval')}},
          {id:'shape:notes',type:'kan-node',x:500,y:100,props:{w:340,h:240,draft:{type:'markdown',title:'Legal review',body:'Legal approval is pending. Budget ceiling: EUR 5000. Do not alter this note unless explicitly asked.'}}}
        ]);
        editor.zoomToFit();
        const text=value=>!value||typeof value!=='object'?'':value.text??value.content?.map(text).filter(Boolean).join(' ')??'';
        const snapshot=()=>editor.getCurrentPageShapes().map(s=>({id:s.id,type:s.type,parentId:s.parentId,x:s.x,y:s.y,rotation:s.rotation,isLocked:s.isLocked,props:s.props,...(s.type==='geo'?{label:text(s.props.richText)}:{})}));
        const output=t.output={input:${JSON.stringify(input)},beforeCanvas:snapshot(),beforeBindings:editor.getBindingsFromShape('shape:launch'),startedAt:new Date().toISOString(),canvasExecutorSource:t.operations.applyAssistantOperations.toString()};
        document.querySelector('#galtea-native-evidence').textContent=${JSON.stringify(`${label}\n${testCase.id}\n\n${input}`)};
        let saved=[],lease,heartbeat;
        const transport=t.transport.createLocalTransport({canvasId:t.id,userId:crypto.randomUUID(),storage:{async read(){return structuredClone(saved)},async write(_id,entries){saved=structuredClone(entries)}},getCanvas:()=>t.operations.assistantCanvasRecords(editor),applyOperations:(operations,provenance)=>t.operations.applyAssistantOperations(editor,operations,provenance)});
        const unsubscribe=transport.subscribe(()=>{});
        const start=performance.now();
        try{
          transport.setExecutorReady(true,'Galtea live provider','own',false);
          await transport.send({id:crypto.randomUUID(),text:'@kan '+${JSON.stringify(input)},anchors:[],files:[],source:'typed'});
          const trigger=transport.snapshot().triggers[0];lease=await transport.claimTrigger(trigger.id);
          const context=await transport.getLocalContext(lease.runId);
          heartbeat=setInterval(()=>transport.heartbeatLocal(lease.runId).catch(()=>{}),10000);
          output.execution=${JSON.stringify(replay ? "recorded-output-replay" : "live-provider")};
          output.canvasImplementation=${JSON.stringify(baselineModule ? "captured-baseline" : "current-working-tree")};
          if(${replay}){
            output.proposedResult=${JSON.stringify(baselineRuns.find(r => r.testCaseId === testCase.id)?.proposedResult ?? null)};
            if(!output.proposedResult)throw new Error('Missing recorded result');
            if(output.proposedResult.sources)output.proposedResult.sources=output.proposedResult.sources.map(s=>s.kind==='entry'?{...s,id:context.value.causeEntries[0].id}:s);
          }else output.proposedResult=await t.agent.runStructured('act',context.value,new AbortController().signal,[],lease.runId);
          await transport.completeLocal(lease.runId,{id:crypto.randomUUID(),revision:context.revision,result:output.proposedResult});
          const turn=saved.find(e=>e.kind==='agent_turn');output.reply=turn?.text;output.turnStatus=turn?.status;
        }catch(error){output.applicationError=String(error);if(lease)await transport.failLocal(lease.runId,'failed').catch(()=>{});}
        finally{clearInterval(heartbeat);unsubscribe();}
        output.afterCanvas=snapshot();output.afterBindings=editor.getBindingsFromShape('shape:launch');output.latencyMs=Math.round(performance.now()-start);
        document.querySelector('#galtea-native-evidence').textContent+='\\n\\n'+JSON.stringify({reply:output.reply,result:output.proposedResult,error:output.applicationError},null,2);
        editor.zoomToFit();t.finished=true;
      })().catch(error=>{t.error=String(error)});return true;
    `);
    await waitFor("window.__galteaNative.finished && !window.__galteaNative.agent.busy", 210000);
    const result = { testCaseId: testCase.id, suite: testCase.suite, metricId: testCase.metricId, ...model, ...evaluate("window.__galteaNative.output") };
    result.canvasExecutorHash = createHash("sha256").update(result.canvasExecutorSource).digest("hex");
    if (results[0]?.canvasExecutorHash) assert.equal(result.canvasExecutorHash, results[0].canvasExecutorHash, "Executor changed within one evaluation version");
    writeFileSync(`${directory}/${label}-executor.js`, result.canvasExecutorSource);
    delete result.canvasExecutorSource;
    results.push(result);
    writeFileSync(outputPath, JSON.stringify(results, null, 2));
    await pause(300);
    drive("shot", `${directory}/${label}-${testCase.id}.png`);
    console.log(JSON.stringify({ case: result.testCaseId, suite: result.suite, error: result.applicationError, ms: result.latencyMs, proposed: result.proposedResult, actualLaunch: result.afterCanvas.find(s => s.id === "shape:launch")?.label, actualColor: result.afterCanvas.find(s => s.id === "shape:launch")?.props.color }));
  }
} finally {
  run(`const t=window.__galteaNative;if(t){t.editor?.run(()=>t.editor.deleteShapes([...t.editor.getCurrentPageShapeIds()]),{ignoreShapeLock:true});t.root?.unmount();t.host?.remove();if(t.originalFetch)window.fetch=t.originalFetch;t.repo?.deleteCanvasEntry(t.id);delete window.__galteaNative;}return true;`);
}
