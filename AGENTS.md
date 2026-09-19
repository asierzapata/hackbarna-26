# Kan — agent guide

Tauri 2 desktop app. React 19 + TypeScript, Vite, TanStack Router (file-based
routes in `apps/desktop/src/routes`), tldraw for the infinite canvas, shadcn
(`base-lyra`, remixicon) for UI primitives.

## Layout

npm workspaces, orchestrated by Turborepo. Every command below runs from the
repo root; the root scripts delegate into the workspace that owns the work.

```
apps/desktop/        the Tauri app — src/, src-tauri/, index.html, vite.config.ts
apps/room-server/    the backend
apps/agent-runner/
packages/protocol/   zod wire schemas, shared
packages/nodes/      tldraw custom shape utils + server-side schema
scripts/drive.mjs    WebDriver client, stays at the root
```

The desktop app owns its own `tsconfig.json`, `components.json` and frontend
dependencies. `@/*` resolves relative to `apps/desktop/tsconfig.json`, so it
kept working across the move.

`turbo.json` defines `build`, `typecheck`, `test` and `dev`. Only the first
three go through turbo — they are cacheable and fan out across workspaces, and
`build` restores `dist/` from the cache rather than re-running Vite.

`dev`, `preview` and `tauri:drive` stay as direct `-w @kan/desktop` delegation
on purpose. They are persistent single-workspace tasks, so turbo caches nothing
for them, and its `@kan/desktop:` log prefix would break the `e2e` skill's
anchored `^error` grep — the wait loop would spin for its full timeout instead
of failing fast.

`packageManager` is pinned in the root `package.json`. Turbo refuses to resolve
the workspace without it.

## Git hooks

`.githooks/`, wired through `core.hooksPath` by the `prepare` script, so they
activate on `npm install` — no husky, no dependency. If your hooks aren't
firing, you haven't run `npm install` since they landed.

| Hook | Runs | Cost |
| --- | --- | --- |
| `pre-commit` | typecheck, **only the workspaces the commit touches** | seconds |
| `pre-push` | typecheck + tests + build, everything | ~10s warm |

Both block on failure. Bypass with `git commit --no-verify` / `git push
--no-verify`, or `KAN_SKIP_HOOKS=1` for both. Use the bypass when you are
mid-refactor and know it is broken — that is what it is for.

Two things to know about them:

- **They check the working tree, not the staged snapshot.** Stashing unstaged
  work would be more correct, but more than one agent writes in this repo at
  once and a stash mid-write is how you lose someone else's work. The trade is
  that a partially-staged commit can pass the hook and still be broken.
- **`tsx --test` exits 0 when its glob matches nothing**, which reads as a pass
  and is not one. `pre-push` counts the test files first and warns loudly on an
  empty suite rather than letting it show green.

Scoping lives in `.githooks/_scope.sh`: `apps/desktop/*` checks the frontend,
`apps/room-server/*` and `apps/agent-runner/*` check the backend, and
`packages/*` or a root config change checks both.

## Commands

| Task | Command |
| --- | --- |
| Dev server (browser) | `npm run dev` — serves on **port 1420**, `strictPort` |
| Dev app (Tauri window) | `npm run tauri dev` |
| Dev app + automation | `npm run tauri:drive` — adds WebDriver on :4445 |
| Drive the running app | `node scripts/drive.mjs <cmd>` — see the `e2e` skill |
| Typecheck (all) | `npm run typecheck` |
| Build one workspace | `npx turbo run build --filter=@kan/desktop` |
| Typecheck (frontend only) | `npm run typecheck -w @kan/desktop` |
| Production build | `npm run build` |
| Room server | `npm run server` |

`tauri.conf.json` points `devUrl` at `http://localhost:1420`, so the port is
fixed — if it's taken, the dev server fails rather than picking another.

## Always e2e test features

**A feature is not done until it has been exercised end to end in a running
app.** Typecheck and `vite build` passing is not sufficient evidence that
anything works — they only prove the code compiles.

This has already failed here twice: the tldraw integration type-checked and
built cleanly while `npm run dev` crashed on startup with 53 unresolved-asset
errors; and the thread panel's accent borders and active-tab styling both
compiled fine and both rendered wrong.

**Read the `e2e` skill before verifying anything** (`.agents/skills/e2e/`). It
has the exact commands, the wait-for-ready loops, and the traps that have
already cost time. The short version:

- Default to the **driver**: `npm run tauri:drive`, wait for port 4445, then
  `node scripts/drive.mjs snapshot | eval | clickText | fill | shot`. This is
  the real WKWebView, so Tauri IPC, native menus and window behaviour are all
  in scope, and the output is structured enough to assert on.
- Use the **browser** (`npm run dev` + chrome-devtools MCP against
  `http://localhost:1420`) only for quick CSS iteration. It cannot test Tauri
  APIs, IPC, window behaviour or native plugins — say so rather than letting a
  browser pass stand in for full coverage.
- **Read the server output before continuing.** A crash appears in the log and
  nowhere else.
- Report what was actually observed. If a step was skipped, say so plainly.

## Agent runner (Devin)

The ACP client lives in Rust (`apps/desktop/src-tauri/src/devin.rs`), inside the
desktop app rather than in the `apps/agent-runner/` workspace: it spawns
`devin acp`, speaks JSON-RPC over stdio, and forwards `session/update`
notifications to the webview as `devin:update` events. The webview side is
`apps/desktop/src/components/devin-context.tsx` (provider + `useDevin`), the
header control is `DevinButton`, and `ChatPanel` turns a prompt turn into a
streaming `AgentEntry`.

- The CLI runs under the user's own Devin subscription; the app never holds a
  model token. `devin auth login` credentials are picked up automatically, and
  `authenticate` with the `devin-browser` method covers a logged-out machine.
- A bundled macOS app inherits a stripped PATH, so the `devin` binary is probed
  at `~/.local/bin`, Homebrew, and `/usr/local/bin`. `DEVIN_BIN` overrides.
- The child's stderr goes to `Stdio::null()` on purpose — the CLI logs heavily
  and an undrained pipe would eventually wedge the agent. Its own log file is at
  `~/.local/share/devin/cli/logs/`.
- Sessions get a scratch cwd under the app data dir, not the repo.
- `session/new` answers with `auth_required` (-32000) rather than failing when
  the CLI has no credentials; that is what the button reads to decide its label.
- Disconnect kills the child and forgets the session; credentials are untouched.
  There is no real logout: `devin acp` does not advertise
  `agentCapabilities.auth.logout`, so the ACP `logout` method is off the table
  and clearing credentials would mean `devin auth logout` — which would log the
  user out of their terminal too.

## Gotchas

- `@tldraw/assets` is excluded from `optimizeDeps` in `vite.config.ts`. Its
  `?url` imports break Vite's dependency pre-bundler. Don't remove it.
- tldraw assets are bundled locally rather than loaded from the tldraw CDN, so
  the canvas works offline in the packaged desktop app.
- The tldraw chunk is ~1.7 MB (530 kB gzipped). Expected for a local app.
- `tauri-plugin-webdriver` is optional and gated behind the `webdriver` Cargo
  feature, not `cfg(debug_assertions)` — Cargo does not evaluate
  `debug_assertions` in `[target.'cfg(...)']`, so the README's suggested form
  would silently fail to link the crate. `cargo tree` confirms it is absent
  from a default build.
- `tsconfig.json` deliberately has no `baseUrl`; TypeScript 6 rejects it. The
  `@/*` path alias resolves relative to the tsconfig without it.
- `ui/spinner.tsx` is typed against the remixicon component, not
  `ComponentProps<"svg">`. Re-adding it via the shadcn CLI reintroduces a type
  error, because remixicon icons reject `children`.
