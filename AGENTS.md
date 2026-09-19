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
packages/nodes/      pure shared tldraw schema (renderers live in apps/desktop)
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

## Agent runner (Devin, OpenAI)

The ACP client lives in Rust (`apps/desktop/src-tauri/src/agent.rs`), inside the
desktop app rather than in the `apps/agent-runner/` workspace: it spawns an ACP
server, speaks JSON-RPC over stdio, and forwards `session/update` notifications
to the webview as `agent:update` events. The webview side is
`apps/desktop/src/components/agent-context.tsx` (provider + `useAgent`), the
header control is `SignInButton`, and `ChatPanel` turns a prompt turn into a
streaming `AgentEntry`.

Two providers, one protocol — the difference between them is a command line and
an env var, so everything below the launcher is shared:

| Provider | Command | Subscription | API key |
| --- | --- | --- | --- |
| Devin | `devin acp` | `devin auth login` creds, else `authenticate` with `devin-browser` | `WINDSURF_API_KEY` |
| OpenAI | `npx -y @agentclientprotocol/codex-acp` | `authenticate` with `chat-gpt` (opens a browser) | `CODEX_API_KEY` |

`Sign In` opens a submenu per provider, each offering *With Subscription* or
*With API Key*; the key is typed into a dialog. One `agent_sign_in(provider,
mode, apiKey)` command covers all four combinations.

- Both CLIs run under the user's own subscription; the app never holds a model
  token. A typed key goes into the child's environment and has to be re-entered
  after a restart. **Kan never writes it down, but the Codex adapter does** — it
  caches whatever it authenticated with in `$CODEX_HOME/auth.json`
  (`{"auth_mode":"apikey","OPENAI_API_KEY":…}`), so `agent_sign_out` deletes that
  file when it is in api-key mode. Don't claim in UI copy that a key never
  touches the disk; it does, just not by our hand. Devin persists nothing from
  `WINDSURF_API_KEY` — verified, `credentials.toml` is untouched by a key
  sign-in.
- Exactly one provider is connected at a time. Signing into the other replaces
  the connection, and a typed key always gets a fresh child, because a child's
  environment is fixed at spawn.
- **Don't take `authMethods[0]`.** The Codex adapter advertises `api-key` first
  and `chat-gpt` second, so the first entry is the wrong one for a subscription.
  `Conn::auth_method` matches on the shape of the id and name instead.
- Devin advertises only `devin-browser` (no api-key method), so its key path
  works purely through the env var and skips `authenticate`.
- A bundled macOS app inherits a stripped PATH, so `devin` and `npx` are probed
  at `$PATH`, `~/.local/bin`, the nvm prefixes, Homebrew and `/usr/local/bin`.
  `DEVIN_BIN` and `NPX_BIN` override.
- The child's stderr goes to `Stdio::null()` on purpose — these CLIs log heavily
  and an undrained pipe would eventually wedge the agent. Devin's own log file
  is at `~/.local/share/devin/cli/logs/`.
- Sessions get a scratch cwd under the app data dir, not the repo.
- A sign-in that fails is dropped from the connection slot rather than left
  there, or the next attempt would reuse the broken child and fail identically.
  A dying reader thread only reports `agent:closed` when it still owns the slot,
  so replacing a provider does not wipe the connection that replaced it.
- Sign-out kills the child and forgets the session; stored subscription
  credentials are untouched. There is no real logout: neither adapter advertises
  `agentCapabilities.auth.logout`, and clearing credentials would mean `devin
  auth logout` / `codex logout` — which would log the user out of their terminal
  too.

## Canvas nodes and the tool layer (`apps/desktop/src/nodes/`)

The agent never touches tldraw directly; it goes through the tool layer.

- `schema.ts` — zod contract (`nodeDraft`, `addNodeInput`, … and `toolSchemas`).
  This is what the future MCP server exposes; keep `.describe()` on fields.
  Pure, no React/DOM imports. Will move to `packages/protocol`.
- `draft.ts` — pure `draftToShapePartial` / `shapeToSummary` mapping. Reusable
  server-side. Will move to `packages/nodes`.
- `shapes/` — tldraw `BaseBoxShapeUtil`s for `kan-markdown`, `kan-chart`,
  `kan-table`, `kan-image`, `kan-map`, and `kan-logo`, registered via
  `createKanShapeUtils()`. Interactive state that must be shared (hidden series,
  sort, selected rows, focusX, map view and selected marker) lives in shape props.
- `tools.ts` — `createCanvasTools(editor)` → `addNode`, `updateNode`,
  `removeNodes`, `connectNodes`, `arrange`, `getCanvas`. Every input is
  zod-parsed first.
- In dev, `window.__kan = { editor, tools }` and `window.__kanErrors` exist.
  There is no node demo palette, node scenario runner, or automatic canvas
  seeding; nodes remain available through the tool layer. Existing room data
  and the separate thread conversation simulator are preserved. Drive tools with
  `node scripts/drive.mjs eval 'window.__kan.tools.getCanvas()'`.

The rich node tools currently operate on offline desktop canvases; they are
not wired into the room server's MCP tools or shared `kan-node` wire schema.
The local Devin ACP path is wired to those offline tools through a loopback
`kan-canvas` MCP bridge. The bridge is exposed only during an active prompt on
the current offline canvas, validates every request with the same zod schemas,
and approves only correlated canvas tool calls; filesystem and terminal calls
remain denied. Online canvases retain only the shared renderer; publishing
rich-node snapshots requires that follow-up schema integration. Offline canvases
register both renderers, preserve duplicated initial records, and reuse
`CanvasProvider`.
Run `node scripts/canvas-tools.e2e.mjs` for tool-layer coverage, and
`node scripts/local-agent.e2e.mjs` with Devin signed in to verify the real local
agent creates the two-day calendar, venue map, and sponsors table. Both tests
clean their own canvas and restore the original page. Do not drive concurrently.

Keys: `apps/desktop/src/lib/config.ts` zod-parses `VITE_MAPTILER_KEY` and
`VITE_BRANDFETCH_CLIENT_ID` from the root `.env.local` (see `.env.example`).
Vite's `envDir` keeps that location stable after the workspace move. Both are
optional — the map falls back to MapLibre demo tiles, the logo to a favicon.
`VITE_*` vars are embedded in the frontend bundle, so only publishable keys
belong there (the Brandfetch *client id* is publishable; its API key is not).
`kan-logo` is deliberately chromeless (no `NodeCard`), aspect-locked, and
`addNode({ near })` overlaps it on the near shape's top-right corner
(`placementByType` in `draft.ts`). The map disables MapLibre's own `dragPan`
and `scrollZoom` and forwards pointer/wheel gestures itself, otherwise tldraw's
transformed layer breaks them.

Pointer model inside a node: the `HTMLContainer` has `pointerEvents: all`; each
interactive control calls `stopEventPropagation` on `pointerdown`; the card
header is the drag handle. Custom shape types must be added to tldraw's
`TLGlobalShapePropsMap` (see `shapes/types.ts`) or `editor.createShape` won't
accept them. Arrow bindings need `snap: "none"` in tldraw 5; labels are
`richText: toRichText(...)`.

## Gotchas

- **The Devin CLI owns `~/.codex`.** It is a Codex fork, and its `auth.json`
  there holds *Devin* tokens in Codex's format. The Codex adapter is therefore
  spawned with `CODEX_HOME` pointed at a scratch dir under the app data dir, so
  the two cannot read each other's credentials. Codex also refuses to start if
  `CODEX_HOME` does not already exist, so we create it first.
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

## Backend verification and integration

The authoritative implemented contract is the new backend section of
`ARCHITECTURE.md` and the schemas in `packages/protocol`, not its historical
host/server-fallback or thread-route proposals. Use Node >=24 from the repo root:

| Task | Command |
| --- | --- |
| Room server (default :8787) | `npm run server` |
| Standalone scoped ACP executor | `npm run runner` |
| Backend TypeScript | `npm run typecheck:backend` |
| Backend runtime tests | `npm run test:backend` |

`apps/agent-runner` is a separate Node/tsx executor, not a replacement for the
existing Rust Devin integration above. Automatic claiming defaults off; configure
its explicit local command and identity through the documented `KAN_*` variables.
No real vendor agent or paid provider is needed for the backend tests: they use
real HTTP/WS, genuine tldraw clients, fake ACP subprocesses with real MCP stdio,
and private temporary directories. Check the actual test count and server output.
A passing desktop build is not native UI coverage; desktop room/runner/video
integration still requires the Tauri driver and the existing e2e guidance.

`@kan/nodes` supplies the pure shared schema; the renderer is in
`apps/desktop/src/lib/canvas-shapes.tsx`. Preserve parallel desktop work and keep
wire-schema changes coordinated. SQLite files/WAL files and `/data/` are ignored;
use temporary `KAN_DATA_DIR` fixtures for verification. Append migrations instead
of deleting user data. Keep installation credentials in the parent; pass only
scoped run leases to MCP, obtain fresh socket tickets on reconnect, and never log
credentials, lease tokens or ticket URLs. The runner is not an OS sandbox.

## Timeline and calendar nodes

- `kan-timeline` and `kan-calendar` share date-only events: stable unique `id`,
  `title`, `start` (`YYYY-MM-DD`), optional inclusive `end`, `description`, and
  `sourceNote`. Years 0001–9999 are supported; no timed events or external sync.
- Timeline expansion (`selectedEventId`), calendar month (`YYYY-MM`), and
  `selectedDate` live in shape props. Selecting a date through `updateNode`
  reveals its month; changing months clears an out-of-month selection.
- Unit checks: `node --test scripts/date-nodes.test.mjs` (Node 22.18+ or 24).
  Repeat with `TZ=America/Los_Angeles` to check date-only timezone handling.
- Running-app regression: start `npm run tauri:drive`, then run
  `node scripts/date-nodes.e2e.mjs`. It creates and removes only its own test
  nodes and restores the camera. Avoid driving the same window concurrently.
