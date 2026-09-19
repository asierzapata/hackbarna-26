---
name: e2e
description: Launch and drive the Kan app to prove a change actually works. Use before claiming any UI or frontend feature is done, when asked to run/start/screenshot the app, to reproduce a bug, or to verify behaviour in the real Tauri window. Covers both the in-app WebDriver driver (real WKWebView, Tauri IPC) and the Chrome dev-server path, and says which to pick.
user-invocable: true
---

# Verifying a change in Kan

**A feature is not done until it has been exercised end to end in a running app.**
`tsc --noEmit` and `vite build` passing is not evidence that anything works —
they only prove the code compiles.

This rule exists because it has already failed here twice:

- The tldraw integration type-checked and built cleanly while `npm run dev`
  crashed on startup with 53 unresolved-asset errors.
- The thread panel's accent borders and active-tab styling both compiled fine
  and both rendered wrong. Only a screenshot caught them.

## Pick a path

| Situation | Path |
| --- | --- |
| Tauri APIs, IPC, native menus, window behaviour, plugins | **Driver** (only option) |
| Asserting on app state, regression checks, anything repeatable | **Driver** |
| Pure CSS/layout iteration where a Rust rebuild isn't worth it | Browser |

Default to the **driver**. It is the real WKWebView, it returns structured
output you can assert on, and the scripts graduate into a test suite. Reach for
the browser only to iterate quickly on styling.

## Driver path (preferred)

The app embeds a W3C WebDriver server on `127.0.0.1:4445`, behind the
`webdriver` Cargo feature so it can never reach a release bundle.

### 1. Start it (background) and wait for the port

```bash
npm run tauri:drive > /tmp/kan-tauri.log 2>&1   # run_in_background: true
```

Then block until it is actually up — **do not assume it booted**. The first
Rust build takes minutes; later ones ~40s.

```bash
# The Tauri CLI forces ANSI colour even when redirected, so strip it before
# grepping — an anchored "^error" never matches a colourised error line and the
# loop would spin for the full 8 minutes instead of failing fast.
for i in $(seq 1 240); do
  nc -z 127.0.0.1 4445 2>/dev/null && { echo PORT_OPEN; break; }
  sed $'s/\033\[[0-9;]*m//g' /tmp/kan-tauri.log \
    | grep -qE "^error(\[|:)|could not compile" && { echo BUILD_ERROR; break; }
  sleep 2
done
tail -20 /tmp/kan-tauri.log
```

Check the result. A crash shows up in that log and nowhere else.

### 2. Drive it

```bash
node scripts/drive.mjs snapshot              # whole thread panel state at once
node scripts/drive.mjs eval '<js expression>'
node scripts/drive.mjs clickText 'Send'      # click a button/tab by label
node scripts/drive.mjs click '<css>'
node scripts/drive.mjs fill '<css>' 'text'   # sets value the way React notices
node scripts/drive.mjs shot /tmp/kan.png     # then Read the file
node scripts/drive.mjs reload                # reset frontend state
```

`snapshot` returns tabs + active state, every entry, button labels, composer
value and footer counts in one call. Prefer it over a pile of `eval`s.

Frontend edits hot-reload into the Tauri webview (it loads the Vite dev server),
so you rarely need to restart. Rust edits trigger a rebuild automatically.

### 3. Stop it when done

Use TaskStop on the background task.

## Browser path

```bash
npm run dev > /tmp/kan-dev.log 2>&1   # background; port 1420, strictPort
```

Wait for the ready banner in the log, then drive `http://localhost:1420` with
the chrome-devtools MCP tools (`navigate_page`, `take_snapshot`, `click`,
`take_screenshot`), and check `list_console_messages` and
`list_network_requests`. A page that renders can still be quietly 404ing.

This does **not** cover Tauri APIs, IPC, window behaviour or native plugins.
Say so explicitly rather than letting a browser pass stand in for it.

## Gotchas that have already bitten

- **Click by label, not by CSS shape.** `button:last-of-type` matched the
  header's *Close thread* button instead of the composer's *Send* and silently
  unmounted the panel. Use `clickText`.
- **A screenshot can lie mid-transition.** Triggers have `transition-all`, so a
  shot taken right after a click can show a half-faded control that looks like a
  contrast bug. Confirm with `getComputedStyle` before reporting one.
- **chrome-devtools MCP won't attach** when a leftover Chrome holds the profile
  lock at `~/.cache/chrome-devtools-mcp/`. It is a throwaway profile, not the
  user's session — but **ask before killing processes**.
- **`npm run dev` uses `strictPort`.** If 1420 is taken it fails rather than
  picking another port.
- **Don't re-run the app to "check" a passing edit.** Re-verify only what the
  change could plausibly have broken.

## Report honestly

State what you actually observed. If a step was skipped or a check didn't run,
say so plainly instead of implying full coverage. If something failed, show the
output.
