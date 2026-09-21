import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { open } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "apps/site/public");
const fps = 8;

export function parseOptions(args) {
  let mode;
  let consent = false;
  let solo = false;
  let microphone;
  let output;
  let seconds = 90;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--check", "--record", "--brief"].includes(arg)) {
      if (mode) throw new Error("Choose one mode: --check, --brief, or --record.");
      mode = arg.slice(2);
    } else if (arg === "--consent") consent = true;
    else if (arg === "--solo") solo = true;
    else if (arg === "--microphone") {
      microphone = args[++i];
      if (!/^\d+$/.test(microphone ?? "")) throw new Error("--microphone must be an AVFoundation audio device index.");
    }
    else if (arg === "--output") output = args[++i];
    else if (arg === "--seconds") seconds = Number(args[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 180) throw new Error("--seconds must be an integer between 1 and 180.");
  if (mode === "record") {
    if (!consent) throw new Error("Recording requires --consent after every participant agrees to capture and public use of this demo.");
    if (!output) throw new Error("Provide --output with a new private recording path.");
    output = resolve(output);
    if (!output.endsWith(".mp4")) throw new Error("The output must end in .mp4.");
    if (output.startsWith(publicDir + sep)) throw new Error("Record outside the public site. Review footage before publishing it.");
  }
  return { mode: mode ?? "check", output, seconds, solo, microphone };
}

export function readinessProblems(state, { solo = false } = {}) {
  const minimumParticipants = solo ? 1 : 2;
  const requirements = [
    [state.native, "Open the real Tauri app with npm run tauri:drive."],
    [state.visible, "Bring the app window into view; hidden WKWebViews freeze animations."],
    [state.online, "Join a dedicated online demo room."],
    [state.canvas, "Wait for the shared canvas to load."],
    [state.thread, "Keep the conversation panel open."],
    [state.agent, "Connect Devin or OpenAI Codex in the recording app."],
    [state.call, "Wait for the video call to connect."],
    [state.participants >= minimumParticipants && state.playingVideos >= minimumParticipants, solo ? "Keep your camera on and visible for the solo narration." : "Have a teammate join with video so both participants are visible."],
    [state.microphone, "Turn on your microphone when ready to share and transcribe the demo conversation."],
    [state.captions, "Wait for the conversation footer to show Call transcript · Live."],
    [state.width >= 1280 && state.height >= 760, "Use an app viewport at least 1280 × 760 with the call and chat visible."],
  ];
  return requirements.filter(([ok]) => !ok).map(([, message]) => message);
}

export const framesDue = (elapsedMs, frameRate) => Math.floor(elapsedMs * frameRate / 1000);

const preflightScript = `return (() => {
  const panel = document.querySelector('aside[aria-label="Thread"]');
  const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const videos = [...document.querySelectorAll('.room-video video')];
  return {
    native: !!window.__TAURI_INTERNALS__, visible: document.visibilityState === 'visible',
    online: location.pathname.startsWith('/room/'), canvas: visible(document.querySelector('.tl-container')),
    thread: visible(panel), agent: document.querySelector('[data-testid="assistant-menu"]')?.getAttribute('data-ready') === 'true',
    call: document.querySelector('.room-video__status')?.textContent.startsWith('Call connected') === true,
    captions: panel?.textContent.includes('Call transcript · Live') === true,
    microphone: !!document.querySelector('.room-video [aria-label="Mute microphone"]'),
    participants: document.querySelectorAll('.room-video__tile').length,
    playingVideos: videos.filter(v => visible(v) && !v.paused && v.readyState >= 2 && v.videoWidth > 0).length,
    width: innerWidth, height: innerHeight
  };
})()`;

const brief = `Kan integrated demo — real session, no injected messages or canvas results

Before recording:
- Use a dedicated demo room with no private content, and get every participant's consent to public use.
- Run npm run tauri:drive. Connect the AI in the app yourself; never record authentication.
- Join the room with a teammate. Keep both camera tiles and the conversation visible.
- Enabling microphones sends speech to Vonage for transcription; live video/transcription and AI may incur usage charges.
- Choose the assistant's "Only when asked" setting for an explicit, repeatable demonstration.
- Wait for Call transcript · Live. Expand the transcript group so speech is readable.
- Run node scripts/record-product-demo.mjs --check. It does not capture screenshots or change the app.

Conversation:
A: "Let's plan a hackathon in Barcelona for 40 people on September 26 and 27. We'd like a space near the beach."
B: "Let's put the dates on the board and compare a few venue options before we decide."

Send from the recording app's composer:
1. "@Kan, add a calendar event called Barcelona hackathon for 26–27 September 2026. These are proposed dates, not a confirmed booking."
2. "@Kan, put a shortlist of three possible coworking venues near Barcelona beach in a table on the canvas. Include location and what we need to verify for 40 people. Do not claim current prices, capacity, or availability are verified."

Finish:
B: "Now we have the dates and the options together. Let's check capacity and availability before we book."
Keep the call and chat visible as the real agent responds and the calendar/table appear.
If the agent fails or takes longer, keep that raw footage; do not substitute staged success.

Record only after consent and live-service approval:
node scripts/record-product-demo.mjs --record --consent --seconds 90 --output /tmp/kan-live-demo.mp4

For a solo narrated walkthrough, add --solo to --check and --record. This requires one
playing camera and does not establish that a multi-person call was demonstrated.
Recording waits up to 90 seconds for successful live checks, then starts after 3 seconds.
TAURI_WEBDRIVER_URL selects a different local driver. FFMPEG_BIN selects an encoder.
By default this captures picture only. --microphone <AVFoundation audio index> also
records that microphone; verify the device and obtain consent before using this option.
It does not turn on call devices, send prompts, create rooms, or publish footage.
Use the visible transcript and add reviewed captions when editing. Mark any shortened waits.
`;

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.mode === "brief") { console.log(brief); return; }
  const base = new URL(process.env.TAURI_WEBDRIVER_URL ?? "http://127.0.0.1:4445");
  if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error("Use a local WebDriver endpoint.");
  const rpc = async (method, path, body) => {
    const response = await fetch(new URL(path, base), {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw new Error("The local WebDriver request failed. Check that the app is running and responsive.");
    return result.value;
  };
  let session;
  try { session = await rpc("POST", "/session", { capabilities: { alwaysMatch: {} } }); }
  catch { throw new Error("Cannot reach the local app driver. Start npm run tauri:drive and try --check again."); }
  const id = session.sessionId ?? session.session_id;
  if (!id) throw new Error("The driver did not create a session.");
  const state = () => rpc("POST", `/session/${id}/execute/sync`, { script: preflightScript, args: [] });
  let encoder;
  let encoding;
  let encoderError;
  let stopped = false;
  const stop = () => { stopped = true; };
  try {
    const live = await state();
    let problems = readinessProblems(live, options);
    if (options.mode === "check") {
      console.log(JSON.stringify({ ready: problems.length === 0, checks: live, nextSteps: problems }, null, 2));
      if (problems.length) process.exitCode = 1;
      return;
    }
    console.log("Armed. Waiting up to 90 seconds for Kan to be visible and the live checks to pass. No recording yet.");
    const readyDeadline = Date.now() + 90000;
    while (problems.length && Date.now() < readyDeadline) {
      await pause(1000);
      problems = readinessProblems(await state(), options);
    }
    if (problems.length) throw new Error(problems.join("\n"));
    console.log("Live checks passed. Recording starts in 3 seconds; keep Kan visible.");
    await pause(3000);
    problems = readinessProblems(await state(), options);
    if (problems.length) throw new Error(problems.join("\n"));
    const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";
    execFileSync(ffmpeg, ["-version"], { stdio: "ignore" });
    const reservation = await open(options.output, "wx", 0o600);
    await reservation.close();
    encoder = spawn(ffmpeg, [
      "-v", "error", "-y", "-thread_queue_size", "128", "-f", "image2pipe", "-vcodec", "png", "-framerate", String(fps), "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0",
      ...(options.microphone === undefined ? [] : ["-thread_queue_size", "128", "-f", "avfoundation", "-i", `:${options.microphone}`, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k", "-shortest"]),
      "-vf", "scale='min(1920,iw)':-2", "-c:v", "libx264", "-preset", "fast", "-crf", "20",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", options.output,
    ], { stdio: ["pipe", "inherit", "inherit"] });
    encoding = once(encoder, "close");
    encoder.stdin.on("error", error => { encoderError = error; });
    process.once("SIGINT", stop);
    console.log(`Recording the live app for up to ${options.seconds} seconds. ${options.microphone === undefined ? "No audio." : "Microphone narration enabled."} Keep the window visible; Ctrl+C stops early.`);
    const shot = async () => Buffer.from(await rpc("GET", `/session/${id}/screenshot`), "base64");
    let previous = await shot();
    const started = performance.now();
    let lastCheck = started;
    let written = 0;
    const writeUntil = async (elapsed) => {
      const target = framesDue(elapsed, fps);
      while (written < target) {
        if (encoderError) throw new Error("Video encoding stopped. The recording is incomplete.");
        if (!encoder.stdin.write(previous)) await once(encoder.stdin, "drain");
        written++;
      }
    };
    while (!stopped && performance.now() - started < options.seconds * 1000) {
      const tick = performance.now();
      if (tick - lastCheck >= 1000) {
        const changed = readinessProblems(await state(), options);
        if (changed.length) throw new Error(`Recording interrupted; review the partial footage.\n${changed.join("\n")}`);
        lastCheck = tick;
      }
      const current = await shot();
      await writeUntil(Math.min(performance.now() - started, options.seconds * 1000));
      previous = current;
      await pause(Math.max(0, 1000 / fps - (performance.now() - tick)));
    }
    await writeUntil(Math.min(performance.now() - started, options.seconds * 1000));
    encoder.stdin.end();
    const [code] = await encoding;
    if (code !== 0) throw new Error("Video encoding failed. The recording is incomplete.");
    console.log(JSON.stringify({ recordedSeconds: written / fps, stoppedEarly: stopped, output: options.output, soloNarration: options.solo, audio: options.microphone !== undefined, published: false }));
  } finally {
    process.removeListener("SIGINT", stop);
    if (encoder && !encoder.stdin.writableEnded) encoder.stdin.end();
    if (encoding) await encoding.catch(() => {});
    await rpc("DELETE", `/session/${id}`).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
