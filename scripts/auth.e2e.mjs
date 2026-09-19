import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "kan-auth-e2e-"));
const identifier = `com.asierzapata.kan.auth-test-${Date.now()}`;
const appData = join(homedir(), "Library", "Application Support", identifier);
const fixture = resolve(root, "scripts/auth-acp-fixture.mjs");
const launcher = join(temp, "agent");
writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`);
chmodSync(launcher, 0o700);
const driver = resolve(root, "scripts/drive.mjs");
const port = 4446;
const frontendPort = 1431;
const env = { ...process.env, TAURI_WEBDRIVER_URL: `http://127.0.0.1:${port}` };
const config = JSON.stringify({ identifier, build: { devUrl: `http://localhost:${frontendPort}`, beforeDevCommand: `npm run dev -- --port ${frontendPort}` } });
let app;
let log = "";
const drive = (...args) => {
  const output = execFileSync(process.execPath, [driver, ...args], { cwd: root, env, encoding: "utf8", timeout: 15000 });
  if (["reload", "shot", "fill", "clickText", "text"].includes(args[0])) return output.trim();
  return JSON.parse(output);
};
const evaluate = (expression) => drive("eval", `({ result: (${expression}) })`).result;
const waitFor = async (predicate, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(250);
  }
  throw new Error(`Timed out: ${String(predicate)}`);
};
const wait = (expression, timeout) => waitFor(() => evaluate(expression), timeout).catch((error) => { throw new Error(`${error.message}: ${expression}`); });
const js = async (expression) => {
  evaluate(`(() => { window.__authCheck = null; Promise.resolve().then(() => (${expression})).then(result => { window.__authCheck = { result }; }, error => { window.__authCheck = { error: String(error) }; }); return true; })()`);
  await wait("window.__authCheck !== null", 120000);
  const response = evaluate("window.__authCheck");
  assert.equal(response.error, undefined, response.error);
  return response.result;
};
const ipc = (command, args = {}) => js(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
const preferences = () => JSON.parse(readFileSync(join(appData, "agent-preferences.json"), "utf8"));
const navigate = async (path) => {
  evaluate(`(() => { window.__authNavigation = true; location.assign(${JSON.stringify(path)}); return true; })()`);
  await wait("!window.__authNavigation && document.readyState === 'complete'");
};
const ready = () => wait("!!document.querySelector('[data-testid=agent-status]')", 120000);
const stop = async () => {
  if (!app || app.exitCode !== null) return;
  const exited = once(app, "exit");
  process.kill(-app.pid, "SIGTERM");
  await exited;
  await pause(1000);
};
const start = async (real = false) => {
  log = "";
  app = spawn("npm", ["run", "tauri", "--", "dev", "--features", "webdriver", "--no-watch", "--config", config], {
    cwd: root,
    detached: true,
    env: { ...process.env, TAURI_WEBDRIVER_PORT: String(port), DEVIN_BIN: real ? "" : launcher, NPX_BIN: launcher, KAN_AUTH_FIXTURE_DIR: temp },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (chunk) => { log += chunk; });
  app.stderr.on("data", (chunk) => { log += chunk; });
  await waitFor(async () => {
    if (app.exitCode !== null || /^error(?:\[|:)|could not compile/m.test(log.replace(/\x1b\[[0-9;]*m/g, ""))) throw new Error(log);
    try { return (await fetch(`http://127.0.0.1:${port}/status`)).ok; } catch { return false; }
  }, 240000);
  console.log(log.replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(-12).join("\n"));
  await wait("!!window.__TAURI_INTERNALS__ && document.querySelector('button') !== null");
};
const signIn = async (provider, mode) => {
  drive("click", "[data-testid=sign-in-button]");
  drive("click", `[data-testid=sign-in-${provider}]`);
  await wait(`!!document.querySelector('[data-testid=sign-in-${provider}-${mode === "api_key" ? "api-key" : "subscription"}]')`);
  drive("click", `[data-testid=sign-in-${provider}-${mode === "api_key" ? "api-key" : "subscription"}]`);
  if (mode === "api_key") {
    await wait("!!document.querySelector('[data-testid=api-key-input]')");
    drive("fill", "[data-testid=api-key-input]", "kan-e2e-not-a-real-key");
    drive("click", "[data-testid=api-key-dialog] button[type=submit]");
  }
  await ready();
};
const signOut = async () => {
  drive("click", "[data-testid=agent-sign-out]");
  await wait("!!document.querySelector('[data-testid=sign-in-button]:not(:disabled)')");
  assert.equal(preferences().autoConnect, false);
};
let canvasPath;
let completed = false;
try {
  await start();
  await wait("!!document.querySelector('#display-name-input')");
  drive("fill", "#display-name-input", "Auth verification");
  drive("clickText", "Continue");
  await wait("!!document.querySelector('[data-testid=agent-setup]')");
  drive("clickText", "OpenAI");
  drive("clickText", "API key");
  assert.equal(evaluate("document.querySelector('#onboarding-api-key').type"), "password");
  assert.equal(evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Connect OpenAI').disabled"), true);
  drive("clickText", "Set up later");
  await wait("location.pathname.startsWith('/canvas/') && !!window.__kan");
  canvasPath = evaluate("location.pathname");
  const catalogCount = await js("import('/src/lib/canvas-repository.ts').then(repo => repo.listLocalCanvases()).then(items => items.length)");
  assert.equal(await js("import('/src/lib/installation-profile.ts').then(repo => repo.getInstallationProfile()).then(profile => profile.onboardingVersion)"), 2);
  console.log("PASS fresh onboarding, masked key field, empty-key validation, and skip without login");

  await js("import('/src/lib/installation-profile.ts').then(async repo => { const profile = await repo.getInstallationProfile(); await repo.saveInstallationProfile({...profile, onboardingVersion: 1}); })");
  await navigate("/");
  await wait("location.pathname === '/onboarding' && !!document.querySelector('[data-testid=agent-setup]')");
  assert.equal(evaluate("!!document.querySelector('#display-name-input')"), false);
  drive("clickText", "Connect Devin");
  await wait("document.body.textContent.includes('Connected to Devin')");
  drive("click", "[data-slot=model-selector] button[aria-haspopup=listbox]");
  drive("clickText", "Fixture Reasoning");
  await waitFor(() => existsSync(join(temp, "selected-model")) && readFileSync(join(temp, "selected-model"), "utf8") === "model-b");
  await waitFor(() => preferences().modelId === "model-b");
  drive("shot", join(temp, "onboarding.png"));
  drive("clickText", "Start creating");
  await wait("location.pathname === '/'");
  assert.equal(await js("import('/src/lib/canvas-repository.ts').then(repo => repo.listLocalCanvases()).then(items => items.length)"), catalogCount);
  console.log("PASS existing-user setup preserves canvases, real ACP model change acknowledged and saved");

  await navigate(canvasPath);
  await ready();
  drive("fill", "textarea", "Verify selected model");
  drive("clickText", "Send");
  await wait("document.body.textContent.includes('Executed by model-b')");
  assert.equal((await ipc("agent_status", { canvasId: canvasPath.split("/").at(-1) })).models.current, "model-b");
  const authCount = readFileSync(join(temp, "auth-count"), "utf8");
  await stop();
  await start();
  await navigate(canvasPath);
  await ready();
  assert.equal((await ipc("agent_status", { canvasId: canvasPath.split("/").at(-1) })).models.current, "model-b");
  assert.equal(readFileSync(join(temp, "auth-count"), "utf8"), authCount);
  console.log("PASS full native restart reconnects subscription and restores model without authenticating again");

  await signOut();
  drive("reload");
  await wait("!!document.querySelector('[data-testid=sign-in-button]:not(:disabled)')");
  assert.equal(evaluate("!!document.querySelector('[data-testid=agent-status]')"), false);
  console.log("PASS explicit sign-out disables automatic reconnection");

  for (const provider of ["devin", "openai"]) {
    await signIn(provider, "api_key");
    const selected = await ipc("agent_set_model", { modelId: "model-b" });
    assert.equal(selected.models.current, "model-b");
    const saved = preferences();
    assert.equal(saved.provider, provider);
    assert.equal(saved.mode, "api_key");
    assert.equal(JSON.stringify(saved).includes("kan-e2e-not-a-real-key"), false);
    assert.equal(evaluate("JSON.stringify(localStorage).includes('kan-e2e-not-a-real-key')"), false);
    await stop();
    await start();
    await navigate(canvasPath);
    await ready();
    const restored = await ipc("agent_status", { canvasId: canvasPath.split("/").at(-1) });
    assert.equal(restored.provider, provider);
    assert.equal(restored.models.current, "model-b");
    assert.equal(restored.mode, "api_key");
    console.log(`PASS ${provider} API key retrieved from real macOS Keychain after native restart; model restored`);
    await signOut();
    if (provider === "openai") assert.equal(existsSync(join(appData, "codex-api-home/auth.json")), false);
    const disabled = preferences();
    writeFileSync(join(appData, "agent-preferences.json"), JSON.stringify({ ...disabled, autoConnect: true }));
    const missing = await ipc("agent_restore", { tools: [], canvasId: canvasPath.split("/").at(-1) });
    assert.equal(missing.state, "unavailable");
    assert.match(missing.message, /Saved API key is unavailable/);
    writeFileSync(join(appData, "agent-preferences.json"), JSON.stringify(disabled));
    console.log(`PASS ${provider} sign-out removes saved Keychain entry and missing-key restoration is recoverable`);
  }

  await signIn("openai", "subscription");
  await stop();
  await start();
  await navigate(canvasPath);
  await ready();
  assert.equal((await ipc("agent_status", { canvasId: canvasPath.split("/").at(-1) })).mode, "subscription");
  await stop();
  writeFileSync(join(temp, "expired"), "true");
  const beforeExpired = readFileSync(join(temp, "auth-count"), "utf8");
  await start();
  await navigate(canvasPath);
  await wait("!!document.querySelector('[data-testid=agent-error]')");
  assert.match(evaluate("document.querySelector('[data-testid=agent-error]').textContent"), /saved login needs attention/);
  assert.equal(readFileSync(join(temp, "auth-count"), "utf8"), beforeExpired);
  console.log("PASS OpenAI subscription restart and expired-login recovery without unsolicited authentication");
  if (process.argv.includes("--real-devin")) {
    await stop();
    await start(true);
    await navigate(canvasPath);
    await wait("!!document.querySelector('[data-testid=sign-in-button]:not(:disabled)')");
    await signIn("devin", "subscription");
    const actual = await ipc("agent_status", { canvasId: canvasPath.split("/").at(-1) });
    assert.ok(actual.models.available.length > 0, "Real Devin did not expose models");
    const alternative = actual.models.available.find(model => model.id !== actual.models.current);
    if (alternative) assert.equal((await ipc("agent_set_model", { modelId: alternative.id })).models.current, alternative.id);
    await stop();
    await start(true);
    await navigate(canvasPath);
    await ready();
    assert.equal((await ipc("agent_status", { canvasId: canvasPath.split("/").at(-1) })).models.current, alternative?.id ?? actual.models.current);
    console.log("PASS real Devin subscription, advertised model selection and native restart (no model prompt sent)");
    await signOut();
  }
  completed = true;
  console.log(`PASS native authentication suite; screenshot: ${join(temp, "onboarding.png")}`);
} catch (error) {
  console.error(log.replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(-25).join("\n"));
  console.error(`Isolated test data: ${appData}; fixture: ${temp}`);
  throw error;
} finally {
  await stop();
  if (existsSync(appData) && completed) {
    rmSync(appData, { recursive: true, force: true });
  }
}
