import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

const driver = fileURLToPath(new URL("./drive.mjs", import.meta.url));
const drive = (...args) => JSON.parse(execFileSync(process.execPath, [driver, ...args], { encoding: "utf8", timeout: 15000, env: { ...process.env, TAURI_WEBDRIVER_URL: process.env.TAURI_WEBDRIVER_URL ?? "http://127.0.0.1:4451" } }));
const evaluate = (expression) => drive("eval", `({result: (${expression})})`).result;
const run = (body) => evaluate(`(() => { ${body} })()`);
const waitFor = async (expression) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (evaluate(expression)) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${expression}; error=${evaluate("window.__assistantSettingsTest?.error")}; host=${evaluate("document.querySelector('#assistant-settings-test')?.textContent?.slice(0,300)")}`);
};

try {
  run(`
    const t = window.__assistantSettingsTest = { saves: [], error: null };
    Promise.all([
      fetch('/src/main.tsx').then(response => response.text()),
      import('/src/components/RoomAssistantSettings.tsx'),
    ]).then(async ([main, module]) => {
      const [react, dom] = await Promise.all([
        import(main.match(/from "([^"]*react[.]js[^"]*)"/)[1]),
        import(main.match(/from "([^"]*react-dom_client[.]js[^"]*)"/)[1]),
      ]);
      const R = react.default ?? react, D = dom.default ?? dom, h = R.createElement;
      function Fixture() {
        const [room, setRoom] = R.useState({ assistantThreshold: 0.5, assistantCooldownMs: 15_000 });
        return h(module.RoomAssistantSettings, { room, onSave: async (next) => { t.saves.push(next); const updated = { ...room, ...next }; setRoom(updated); return updated; } });
      }
      t.host = document.createElement('div');
      t.host.id = 'assistant-settings-test';
      t.host.style.cssText = 'position:fixed;inset:0;z-index:9999;padding:24px;background:var(--background);width:420px';
      document.body.appendChild(t.host);
      t.root = D.createRoot(t.host);
      t.root.render(h(Fixture));
    }).catch(error => { t.error = String(error); });
    return true;
  `);
  await waitFor("!!window.__assistantSettingsTest && !!document.querySelector('#assistant-settings-test [data-testid=assistant-threshold] input')");
  assert.equal(evaluate("window.__assistantSettingsTest.error"), null);
  assert.equal(evaluate("document.querySelectorAll('#assistant-settings-test input[type=range]').length"), 2);
  assert.equal(evaluate("document.querySelector('#assistant-settings-test [data-testid=assistant-threshold-value]').textContent"), "0.50");
  assert.equal(evaluate("document.querySelector('#assistant-settings-test [data-testid=assistant-cooldown-value]').textContent"), "15s");
  run(`
    const set = (selector, value) => { const input = document.querySelector(selector + ' input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
    set('[data-testid=assistant-threshold]', 0.25);
    set('[data-testid=assistant-cooldown]', 0);
    return true;
  `);
  await waitFor("window.__assistantSettingsTest.saves.length === 2");
  assert.deepEqual(evaluate("window.__assistantSettingsTest.saves"), [{ assistantThreshold: 0.25 }, { assistantCooldownMs: 0 }]);
  assert.equal(evaluate("document.querySelector('#assistant-settings-test [data-testid=assistant-threshold-value]').textContent"), "0.25");
  assert.equal(evaluate("document.querySelector('#assistant-settings-test [data-testid=assistant-cooldown-value]').textContent"), "0s");
  console.log("PASS assistant settings sliders render, expose labels, commit threshold/cooldown changes, and preserve zero cooldown");
} finally {
  run(`const t = window.__assistantSettingsTest; t?.root?.unmount(); t?.host?.remove(); delete window.__assistantSettingsTest; return true;`);
}
