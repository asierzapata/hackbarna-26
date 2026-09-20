import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  for (let attempt = 0; attempt < 100; attempt++) {
    const error = evaluate("window.__callTheme?.error");
    assert.ok(!error, error);
    if (evaluate(expression)) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${expression}; ${JSON.stringify(evaluate("({videos:[...document.querySelectorAll('#call-theme video')].map(v=>({width:v.videoWidth,paused:v.paused,ready:v.readyState,connected:v.isConnected,tracks:v.srcObject?.getTracks().map(t=>({state:t.readyState,muted:t.muted}))})),subscriptions:window.__callTheme?.subscriptions.length,playError:window.__callTheme?.playError})"))}`);
};
const style = (selector, property) => evaluate(`getComputedStyle(document.querySelector('#call-theme ' + ${JSON.stringify(selector)}))[${JSON.stringify(property)}]`);
const click = (label) => drive("click", `#call-theme button[aria-label="${label}"]`);
let mounted = false;

try {
  assert.equal(evaluate("!!window.__TAURI_INTERNALS__"), true);
  assert.equal(evaluate("!!window.__callTheme"), false, "A call-theme fixture is already mounted");
  mounted = true;
  run(`
    const t = window.__callTheme = {subscriptions:[], retries:0, cancelled:0, requests:[]};
    t.dark = document.documentElement.classList.contains('dark');
    Promise.all(['/src/main.tsx','/src/components/RoomVideo.tsx','/src/components/Canvas.tsx'].map(url=>fetch(url).then(r=>r.text()))).then(async ([main,room,canvas]) => {
      const [react,dom,video,context,tldraw,assets,media] = await Promise.all([
        import(main.match(/from "([^"]*react[.]js[^"]*)"/)[1]),
        import(main.match(/from "([^"]*react-dom_client[.]js[^"]*)"/)[1]),
        import('/src/components/RoomVideo.tsx'),
        import(room.match(/from "([^"]*canvas-context.tsx[^"]*)"/)[1]),
        import(room.match(/from "([^"]*tldraw[.]js[^"]*)"/)[1]),
        import(canvas.match(/from "([^"]*assets[^\"]*imports[.]vite[^\"]*)"/)[1]),
        import('/src/lib/room-media.ts'),
        import('/src/components/Canvas.tsx'),
      ]);
      const R = react.default ?? react, h = R.createElement;
      t.pattern = document.createElement('canvas'); t.pattern.width=640; t.pattern.height=360;
      const paint = () => {const ctx=t.pattern.getContext('2d');ctx.fillStyle='#253443';ctx.fillRect(0,0,640,360);ctx.fillStyle='#91a6b9';ctx.fillRect(40,40,560,280);ctx.fillStyle='#253443';ctx.font='32px sans-serif';ctx.fillText('Synthetic camera preview',110,185);};
      paint(); t.timer=setInterval(paint,100);
      t.video = t.pattern.captureStream(10);
      t.audio = new AudioContext(); const destination=t.audio.createMediaStreamDestination();
      t.oscillator=t.audio.createOscillator(); t.oscillator.connect(destination); t.oscillator.start();
      t.media=new media.LocalMedia(async constraints=>{
        t.requests.push(constraints);
        if(t.denied)throw new DOMException('fixture denial','NotAllowedError');
        if(t.pending)return new Promise(resolve=>t.release=resolve);
        return new MediaStream([(constraints.video ? t.video.getVideoTracks()[0] : destination.stream.getAudioTracks()[0]).clone()]);
      });
      t.session={subscribe(stream,target,options,callback){
        const element=document.createElement('video');element.autoplay=true;element.muted=true;element.playsInline=true;
        element.style.cssText='width:100%;height:100%;object-fit:cover';element.srcObject=t.video;target.appendChild(element);void element.play().catch(error=>{t.playError=String(error);});
        const handlers={}; const subscriber={element,options,handlers,on:(name,fn)=>handlers[name]=fn,off:()=>{},subscribeToAudio:{promise:async()=>{handlers.audioUnblocked?.();}}};
        t.subscriptions.push(subscriber);setTimeout(()=>callback(null),0);return subscriber;
      },unsubscribe(subscriber){subscriber.element.srcObject=null;subscriber.element.remove();}};
      const assetUrls=assets.getAssetUrlsByImport();
      const remoteStream={streamId:'fixture-stream',hasAudio:false};
      function Fixture(){
        const state=R.useSyncExternalStore(t.media.subscribe,t.media.getSnapshot);
        const [joined,setJoined]=R.useState(false),[failed,setFailed]=R.useState(false);
        t.join=setJoined;t.fail=setFailed;
        const {setEditor}=context.useCanvas();
        const onMount=R.useCallback(editor=>{t.editor=editor;setEditor(editor);},[setEditor]);
        const controls={media:t.media,state,devices:[{deviceId:'fixture-camera',kind:'videoinput',label:'Fixture camera'},{deviceId:'fixture-mic',kind:'audioinput',label:'Fixture microphone'}]};
        const call={session:t.session,peers:[{connectionId:'remote',userId:'remote',name:'Morgan Chen',stream:remoteStream},{connectionId:'off',userId:'off',name:'Alex with a very long participant name'}],status:failed?'Call unavailable':'Call connected',error:failed?'Controlled connection failure. Your canvas is still available.':null,retry:()=>{t.retries++;setFailed(false);}};
        return joined ? h('main',{style:{position:'relative',height:'100%'}},
          h(tldraw.Tldraw,{assetUrls,hideUi:true,onMount}),
          h(video.RoomParticipantStrip,{name:'Sam Rivera',controls,call})
        ) : h(video.RoomPrejoin,{title:'Product planning',name:'Sam Rivera',controls,onJoin:()=>setJoined(true),onCancel:()=>t.cancelled++});
      }
      t.host=document.createElement('div');t.host.id='call-theme';t.host.style.cssText='position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;background:var(--background)';
      document.body.appendChild(t.host);t.root=(dom.default??dom).createRoot(t.host);
      t.root.render(h(context.CanvasProvider,null,h(Fixture)));
    }).catch(error=>{t.error=String(error);}); return true;
  `);
  await waitFor("!!document.querySelector('#call-theme .room-prejoin__preview')");
  assert.equal(style(".room-prejoin__preview", "borderRadius"), "0px");
  assert.equal(style(".room-prejoin__you", "borderRadius"), "0px");
  assert.equal(style(".room-video__initials", "borderRadius"), "0px");
  assert.match(style("#prejoin-title", "fontFamily"), /JetBrains/);
  click("Turn camera on");
  await waitFor("document.querySelector('#call-theme video')?.videoWidth > 0");
  click("Unmute microphone");
  await waitFor("!!window.__callTheme.media.getSnapshot().audio.track");
  click("Mute microphone");
  assert.equal(evaluate("window.__callTheme.media.getSnapshot().audio.track"), null);
  run("const select=document.querySelector('#call-theme #room-video-input');select.value='fixture-camera';select.dispatchEvent(new Event('change',{bubbles:true}));return true;");
  await waitFor("window.__callTheme.media.getSnapshot().video.deviceId === 'fixture-camera' && !window.__callTheme.media.getSnapshot().video.pending");
  drive("shot", "/tmp/kan-call-lobby.png");
  console.log("PASS square lobby, shared heading font, synthetic camera preview, device selection and microphone toggles");

  for (const dark of [false, true]) {
    run(`document.documentElement.classList.toggle('dark',${dark});return true;`);
    assert.equal(evaluate("(() => {const el=document.querySelector('#call-theme .room-prejoin');const probe=document.createElement('span');probe.style.background='var(--background)';el.appendChild(probe);const equal=getComputedStyle(el).backgroundColor===getComputedStyle(probe).backgroundColor;probe.remove();return equal;})()"), true);
  }
  run("document.documentElement.classList.toggle('dark',window.__callTheme.dark);window.__callTheme.denied=true;return true;");
  click("Turn camera off");click("Turn camera on");
  await waitFor("document.querySelector('#call-theme').textContent.includes('permission is blocked')");
  assert.equal(evaluate("[...document.querySelectorAll('#call-theme button')].find(b=>b.textContent==='Join room').disabled"), false);
  run("window.__callTheme.denied=false;window.__callTheme.pending=true;return true;");
  click("Turn camera on");
  await waitFor("!!document.querySelector('#call-theme .room-prejoin__pending')");
  assert.equal(style(".room-prejoin__pending", "borderRadius"), "0px");
  assert.equal(evaluate("[...document.querySelectorAll('#call-theme button')].find(b=>b.textContent==='Join room').disabled"), true);
  run("[...document.querySelectorAll('#call-theme button')].find(b=>b.textContent==='Join without devices').click();return true;");
  await waitFor("!!document.querySelector('#call-theme .room-video__tile') && !!window.__callTheme.editor");
  run("window.__callTheme.pending=false;window.__callTheme.release(new MediaStream([window.__callTheme.video.getVideoTracks()[0].clone()]));return true;");
  await waitFor("window.__callTheme.subscriptions.length > 0");
  assert.equal(evaluate("window.__callTheme.subscriptions[0].options.showControls"), false);
  assert.equal(style(".room-video__tile", "borderRadius"), "0px");
  assert.equal(style(".room-video__muted", "borderRadius"), "0px");
  assert.equal(style(".room-video__status", "borderRadius"), "0px");
  assert.equal(style(".room-video__footer", "borderTopWidth"), "1px");
  assert.match(style(".room-video__footer", "fontFamily"), /JetBrains/);
  await waitFor("document.querySelector('#call-theme .room-video__stream video')?.videoWidth > 0");
  drive("shot", "/tmp/kan-call-participants.png");
  console.log("PASS denied/pending lobby states, join without devices, remote synthetic video, square tiles/labels and footer divider");

  click("Turn camera on");await waitFor("!!document.querySelector('#call-theme .room-video__local')");
  click("Turn camera off");await waitFor("!document.querySelector('#call-theme .room-video__local')");
  run("window.__callTheme.subscriptions[0].handlers.audioBlocked();return true;");
  await waitFor("document.querySelector('#call-theme').textContent.includes('Enable sound')");
  assert.equal(style(".room-video__notice", "borderRadius"), "0px");
  run("[...document.querySelectorAll('#call-theme button')].find(b=>b.textContent==='Enable sound').click();return true;");
  await waitFor("!document.querySelector('#call-theme .room-video__notice')");
  run("window.__callTheme.fail(true);return true;");
  await waitFor("document.querySelector('#call-theme').textContent.includes('Retry call')");
  run("[...document.querySelectorAll('#call-theme button')].find(b=>b.textContent==='Retry call').click();return true;");
  await waitFor("window.__callTheme.retries===1 && document.querySelector('#call-theme .room-video__status').textContent==='Call connected'");
  run("window.__callTheme.host.style.width='360px';return true;");
  await pause(250);
  assert.equal(evaluate("(() => {const h=window.__callTheme.host.getBoundingClientRect(),s=document.querySelector('#call-theme .room-video__strip').getBoundingClientRect();return s.left>=h.left && s.right<=h.right;})()"), true);
  assert.equal(evaluate("(() => {const s=document.querySelector('#call-theme .room-video__strip');s.scrollLeft=s.scrollWidth;return s.scrollLeft>0;})()"), true);
  drive("shot", "/tmp/kan-call-participants-narrow.png");
  console.log("PASS in-call camera toggles, blocked-audio recovery, retry and narrow participant-strip scrolling (controlled SDK fixture, not a live Vonage call)");
} finally {
  if (mounted) run("const t=window.__callTheme;if(t){t.root?.unmount();t.host?.remove();t.media?.dispose();clearInterval(t.timer);t.video?.getTracks().forEach(track=>track.stop());t.oscillator?.stop();void t.audio?.close();document.documentElement.classList.toggle('dark',t.dark);delete window.__callTheme;}return true;");
}
