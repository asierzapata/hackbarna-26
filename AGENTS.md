# Kan — agent guide

Tauri 2 desktop app. React 19 + TypeScript, Vite, TanStack Router (file-based
routes in `src/routes`), tldraw for the infinite canvas, shadcn (`base-lyra`,
remixicon) for UI primitives.

## Commands

| Task | Command |
| --- | --- |
| Dev server (browser) | `npm run dev` — serves on **port 1420**, `strictPort` |
| Dev app (Tauri window) | `npm run tauri dev` |
| Typecheck | `npx tsc --noEmit` |
| Production build | `npm run build` |

`tauri.conf.json` points `devUrl` at `http://localhost:1420`, so the port is
fixed — if it's taken, the dev server fails rather than picking another.

## Always e2e test features

**A feature is not done until it has been exercised end to end in a running
app.** Typecheck and `vite build` passing is not sufficient evidence that
anything works — they only prove the code compiles.

This rule exists because it has already failed here: the tldraw integration
type-checked and built cleanly while `npm run dev` crashed on startup with 53
unresolved-asset errors. A build-only check reported success on a broken app.

The loop:

1. Start the dev server: `npm run dev` (background).
2. **Read the server output before continuing.** Vite prints the ready banner
   and the local URL; a crash appears here and nowhere else.
3. Drive `http://localhost:1420` with the chrome-devtools MCP tools — navigate,
   `take_snapshot`, interact (click / drag / type), `take_screenshot`.
4. Check `list_console_messages` and `list_network_requests` for errors and
   failed asset loads. A page that renders can still be quietly 404ing.
5. Report what was actually observed. If a step was skipped or a check didn't
   run, say so plainly rather than implying full coverage.

### Browser vs Tauri webview

The chrome-devtools MCP drives Chrome against the Vite dev server, not the
Tauri webview. That covers frontend-only work. Anything touching Tauri APIs,
IPC, window behaviour, or native plugins is **not** covered by browser testing
and needs `npm run tauri dev` — state this limit explicitly instead of letting
a browser pass stand in for it.

### If chrome-devtools MCP won't attach

It fails with "browser is already running for .../chrome-profile" when a
leftover Chrome holds the profile lock at `~/.cache/chrome-devtools-mcp/`.
Either quit that instance (it's a throwaway profile, not the user's browsing
session) or run the MCP server with `--isolated`. Ask before killing processes.

## Gotchas

- `@tldraw/assets` is excluded from `optimizeDeps` in `vite.config.ts`. Its
  `?url` imports break Vite's dependency pre-bundler. Don't remove it.
- tldraw assets are bundled locally rather than loaded from the tldraw CDN, so
  the canvas works offline in the packaged desktop app.
- The tldraw chunk is ~1.7 MB (530 kB gzipped). Expected for a local app.
