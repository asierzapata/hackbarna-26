import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

execFileSync(process.env.FFMPEG_BIN ?? "ffmpeg", ["-version"], { stdio: "ignore" });
const origin = process.env.KAN_MEDIA_ORIGIN ?? "http://localhost:1432";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const targets = await fetch("http://127.0.0.1:9333/json/list").then(r => r.json());
const target = targets.find(t => t.type === "page" && (t.url === "about:blank" || t.url.startsWith(origin + "/")));
assert.ok(target, "Start a dedicated Chrome on :9333 with a fresh profile and an about:blank tab");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await once(ws, "open");
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id) return;
  const job = pending.get(message.id);
  if (!job) return;
  pending.delete(message.id);
  message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result);
});
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const waitFor = async (expression) => {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return;
    await pause(150);
  }
  throw new Error(`Timed out: ${expression}`);
};
const output = name => fileURLToPath(new URL(`../apps/site/public/${name}`, import.meta.url));
const encodeImage = async (name, buffer, filter) => {
  const child = spawn(process.env.FFMPEG_BIN ?? "ffmpeg", ["-v", "error", process.argv.includes("--replace") ? "-y" : "-n", "-f", "image2pipe", "-i", "pipe:0", "-vf", filter, "-frames:v", "1", "-c:v", "libwebp", "-quality", "88", output(name)], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.end(buffer);
  const [code] = await once(child, "close");
  assert.equal(code, 0);
};
const screenshot = async () => Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64");
const click = async (selector) => {
  const point = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing control'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
};

let video;
try {
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1050, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: origin });
  await waitFor("!!document.querySelector('#root')?.children.length");
  await evaluate(`(async () => { const {completeOnboarding}=await import('/src/lib/onboarding.ts');await completeOnboarding('Kan demo');const repo=await import('/src/lib/canvas-repository.ts');const canvas=await repo.createOfflineCanvas({name:'A small team, a big idea'});location.assign('/canvas/'+canvas.id); })()`);
  await waitFor("!!window.__kan");
  await evaluate(`(() => {
    const t=window.__kan.tools;window.__siteMedia={};
    const add=(key,draft,x,y,w,h)=>{const {shapeId}=t.addNode({draft,at:{x,y}});window.__siteMedia[key]=shapeId;t.updateNode({shapeId,patch:{type:draft.type,w,h}});};
    add('brief',{type:'markdown',title:'A weekend worth making',body:'## The idea\\nBring 40 curious people together to build something useful.\\n\\n- **Where:** Barcelona\\n- **When:** September 26–27\\n- **Format:** Small teams. Real prototypes.\\n\\n**Start with a question. Leave with something you can show.**'},0,0,380,320);
    add('table',{type:'table',title:'Find the right space',columns:['Space','Capacity','Day rate','Best for'],rows:[['The studio',40,'€450','Hands-on building'],['The courtyard',60,'€650','Demos + conversation'],['The workshop',45,'€520','Small team sessions']],highlightRow:0,sourceNote:'Sample venues · illustrative estimates'},425,0,640,285);
    add('chart',{type:'chart',title:'Make the budget work',spec:{kind:'bar',x:'category',series:[{key:'budget',label:'Budget (€)'},{key:'estimate',label:'Estimate (€)'}]},data:[{category:'Space',budget:1000,estimate:900},{category:'Food',budget:800,estimate:720},{category:'Materials',budget:400,estimate:300},{category:'Extras',budget:300,estimate:180}],sourceNote:'Sample planning budget · not live pricing'},425,330,640,350);
    add('timeline',{type:'timeline',title:'From idea to demo',events:[{id:'welcome',title:'Meet & form teams',start:'2026-09-25',description:'Share a question, find your people, choose a direction.'},{id:'build',title:'Make something real',start:'2026-09-26',description:'Sketch, test, and build a first prototype.'},{id:'show',title:'Show what you made',start:'2026-09-27',description:'Live demos, honest feedback, and the next step.'}],sourceNote:'Kickoff + a two-day hackathon · sample plan'},0,365,380,360);
    document.querySelector('[aria-label="Close thread"]').click();
  })()`);
  await pause(1500);
  await evaluate(`(() => { [...document.querySelectorAll('button')].find(b=>b.textContent==='Got it')?.click();document.querySelector('[aria-label="Close thread"]')?.click();window.__kan.editor.selectNone(); })()`);
  await pause(400);
  await evaluate("void window.__kan.editor.zoomToFit({inset:220})");
  await waitFor("document.querySelectorAll('.recharts-bar-rectangle path').length === 8");
  await pause(1800);
  assert.deepEqual(await evaluate("window.__kanErrors"), []);
  const image = await screenshot();
  await encodeImage("canvas-overview.webp", image, "scale=1600:1050");
  const bounds = await evaluate(`(() => {const e=document.querySelector('[data-shape-id="'+window.__siteMedia.table+'"]'),c=document.querySelector('[data-shape-id="'+window.__siteMedia.chart+'"]'),a=e.getBoundingClientRect(),b=c.getBoundingClientRect();return {x:Math.floor(a.x-18),y:Math.floor(a.y-18),w:Math.ceil(a.width+36),h:Math.ceil(b.bottom-a.y+36)};})()`);
  await encodeImage("canvas-detail.webp", image, `crop=${bounds.w}:${bounds.h}:${bounds.x}:${bounds.y}`);
  video = spawn(process.env.FFMPEG_BIN ?? "ffmpeg", ["-v", "error", process.argv.includes("--replace") ? "-y" : "-n", "-f", "image2pipe", "-framerate", "10", "-i", "pipe:0", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output("canvas-walkthrough.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
  for (let frame = 0; frame < 200; frame++) {
    const start = performance.now();
    if (frame === 25) await click('[aria-label="Sort by Capacity"]');
    if (frame === 50) await click('[aria-label="Sort by Capacity"]');
    if (frame === 75) await click('[data-testid="legend-budget"]');
    if (frame === 105) await click('[data-testid="legend-budget"]');
    if (frame === 130) await click('[data-event-id="welcome"] button');
    if (frame === 155) await click('[data-event-id="welcome"] button');
    if (frame === 165) await evaluate("void window.__kan.editor.zoomToBounds(window.__kan.editor.getShapePageBounds(window.__siteMedia.table),{inset:180,animation:{duration:650}})");
    if (frame === 185) await evaluate("void window.__kan.editor.zoomToFit({inset:220,animation:{duration:650}})");
    if (!video.stdin.write(await screenshot())) await once(video.stdin, "drain");
    await pause(Math.max(0, 100 - (performance.now() - start)));
  }
  video.stdin.end();
  const [code] = await once(video, "close");
  assert.equal(code, 0);
  assert.deepEqual(await evaluate("window.__kanErrors"), []);
  console.log("Captured two real renderer screenshots and a 20-second canvas interaction walkthrough in isolated Chromium; no native IPC or live AI claims.");
} finally {
  video?.stdin.end();
  ws.close();
}
