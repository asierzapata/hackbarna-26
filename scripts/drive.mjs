#!/usr/bin/env node
/**
 * Drives the running Tauri app through the embedded W3C WebDriver server.
 *
 * Requires the app to be running with the automation server enabled:
 *   npm run tauri:drive
 *
 * Usage:
 *   node scripts/drive.mjs eval '<js>'            evaluate JS in the webview
 *   node scripts/drive.mjs text <css>             textContent of a selector
 *   node scripts/drive.mjs click <css>            click an element
 *   node scripts/drive.mjs clickText <label>      click a button/tab by its label
 *   node scripts/drive.mjs reload                 reload the webview
 *   node scripts/drive.mjs fill <css> <value>     set an input's value
 *   node scripts/drive.mjs shot [path]            PNG screenshot (default /tmp/kan.png)
 *   node scripts/drive.mjs snapshot               compact a11y-ish dump of the thread panel
 *
 * `eval` returns whatever the script returns, JSON-encoded. Sessions are
 * created and torn down per invocation — webview state lives in the app, so
 * each call still sees the results of the last one.
 */
const BASE = process.env.TAURI_WEBDRIVER_URL ?? "http://127.0.0.1:4445";

async function rpc(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  if (json.value?.error) {
    throw new Error(`${json.value.error}: ${json.value.message ?? ""}`);
  }
  return json.value;
}

async function withSession(fn) {
  const session = await rpc("POST", "/session", {
    capabilities: { alwaysMatch: {} },
  });
  const id = session.sessionId ?? session.session_id;
  if (!id) throw new Error(`no sessionId in ${JSON.stringify(session)}`);
  try {
    return await fn((method, path, body) =>
      rpc(method, `/session/${id}${path}`, body)
    );
  } finally {
    await rpc("DELETE", `/session/${id}`).catch(() => {});
  }
}

const evalJs = (call, script, args = []) =>
  call("POST", "/execute/sync", { script, args });

const commands = {
  async eval(call, [script]) {
    return evalJs(call, `return (${script})`, []);
  },

  async text(call, [selector]) {
    return evalJs(
      call,
      `return document.querySelector(arguments[0])?.textContent ?? null`,
      [selector]
    ).then((v) => v);
  },

  async click(call, [selector]) {
    return evalJs(
      call,
      `const el = document.querySelector(arguments[0]);
       if (!el) throw new Error("no element for " + arguments[0]);
       el.click();
       return true;`,
      [selector]
    );
  },

  /** Click a button by its visible text or aria-label. Safer than a CSS
   *  selector when several controls share a shape. */
  async clickText(call, [needle]) {
    return evalJs(
      call,
      `const want = arguments[0].toLowerCase();
       const el = [...document.querySelectorAll('button,[role=tab]')].find((b) =>
         ((b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase()) === want);
       if (!el) throw new Error("no control labelled " + arguments[0]);
       el.click();
       return true;`,
      [needle]
    );
  },

  async reload(call) {
    await evalJs(call, `location.reload(); return true;`, []);
    return "reloaded";
  },

  async fill(call, [selector, ...rest]) {
    const value = rest.join(" ");
    // React listens for the input event, and its value setter is patched on the
    // prototype — assigning `.value` directly would not notify it.
    return evalJs(
      call,
      `const el = document.querySelector(arguments[0]);
       if (!el) throw new Error("no element for " + arguments[0]);
       const proto = el instanceof HTMLTextAreaElement
         ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
       Object.getOwnPropertyDescriptor(proto, "value").set.call(el, arguments[1]);
       el.dispatchEvent(new Event("input", { bubbles: true }));
       return el.value;`,
      [selector, value]
    );
  },

  async shot(call, [path = "/tmp/kan.png"]) {
    const b64 = await call("GET", "/screenshot");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, Buffer.from(b64, "base64"));
    return path;
  },

  /** Compact dump of the thread panel: entries, controls, composer state. */
  async snapshot(call) {
    return evalJs(
      call,
      `const panel = document.querySelector('[aria-label="Thread"]');
       if (!panel) return { error: "thread panel not mounted" };
       const q = (s) => [...panel.querySelectorAll(s)];
       return {
         tabs: q('[data-slot=tabs-trigger]').map((t) => ({
           label: t.textContent, active: t.dataset.selected != null || t.getAttribute('data-active') != null,
         })),
         entries: q('[data-slot=message-scroller-item]').map((el) =>
           el.textContent.replace(/\\s+/g, " ").trim().slice(0, 120)
         ),
         buttons: q('button').map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean),
         composer: panel.querySelector('textarea')?.value ?? null,
         footer: q('div').at(-1)?.textContent ?? null,
       };`,
      []
    );
  },
};

const [cmd, ...args] = process.argv.slice(2);
const handler = commands[cmd];
if (!handler) {
  console.error(`unknown command "${cmd ?? ""}"; expected one of: ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}

withSession((call) => handler(call, args))
  .then((result) => {
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error(String(err.message ?? err));
    process.exit(1);
  });
