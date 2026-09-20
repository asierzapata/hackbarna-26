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

| Hook         | Runs                                                  | Cost      |
| ------------ | ----------------------------------------------------- | --------- |
| `pre-commit` | typecheck, **only the workspaces the commit touches** | seconds   |
| `pre-push`   | typecheck + tests + build, everything                 | ~10s warm |

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

| Task                      | Command                                               |
| ------------------------- | ----------------------------------------------------- |
| Dev server (browser)      | `npm run dev` — serves on **port 1420**, `strictPort` |
| Dev app (Tauri window)    | `npm run tauri dev`                                   |
| Dev app + automation      | `npm run tauri:drive` — adds WebDriver on :4445       |
| Drive the running app     | `node scripts/drive.mjs <cmd>` — see the `e2e` skill  |
| Typecheck (all)           | `npm run typecheck`                                   |
| Build one workspace       | `npx turbo run build --filter=@kan/desktop`           |
| Typecheck (frontend only) | `npm run typecheck -w @kan/desktop`                   |
| Production build          | `npm run build`                                       |
| Room server               | `npm run server`                                      |

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

| Provider | Command                                 | Subscription                                                       | API key            |
| -------- | --------------------------------------- | ------------------------------------------------------------------ | ------------------ |
| Devin    | `devin acp`                             | `devin auth login` creds, else `authenticate` with `devin-browser` | `WINDSURF_API_KEY` |
| OpenAI   | `npx -y @agentclientprotocol/codex-acp` | `authenticate` with `chat-gpt` (opens a browser)                   | `CODEX_API_KEY`    |

`Sign In` opens a submenu per provider, each offering _With Subscription_ or
_With API Key_; the key is typed into a dialog. One `agent_sign_in(provider,
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
- The child's stderr is continuously drained on a dedicated thread so it cannot
  wedge the agent. Default diagnostics retain only byte counts; the optional
  five-minute detail capture keeps a bounded, redacted tail in memory, never in
  the rotating metadata log. Devin's own log file is at
  `~/.local/share/devin/cli/logs/`.
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
- `tools.ts` — `createCanvasTools(editor)` → `addNode`, `addMermaidDiagram`,
  `updateNode`, `removeNodes`, `connectNodes`, `arrange`, `focusNodes`,
  `groupNodes`, `getCanvas`. Every input is zod-parsed first.
- In dev, `window.__kan = { editor, tools }` and `window.__kanErrors` exist.
  There is no node demo palette, node scenario runner, or automatic canvas
  seeding; nodes remain available through the tool layer. Existing room data is
  preserved; the thread conversation simulator is gone. Drive tools with
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
Run `node scripts/canvas-tools.e2e.mjs` for tool-layer coverage. It cleans its
own canvas and restores the original page. Do not drive concurrently. The old
`local-agent.e2e.mjs` drove the deleted conversation simulator and went with it;
real local-agent coverage now goes through the chat composer.

Keys: `apps/desktop/src/lib/config.ts` zod-parses `VITE_MAPTILER_KEY` and
`VITE_BRANDFETCH_CLIENT_ID` from the root `.env.local` (see `.env.example`).
Vite's `envDir` keeps that location stable after the workspace move. Both are
optional — the map falls back to MapLibre demo tiles, the logo to a favicon.
`VITE_*` vars are embedded in the frontend bundle, so only publishable keys
belong there (the Brandfetch _client id_ is publishable; its API key is not).
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
  there holds _Devin_ tokens in Codex's format. The Codex adapter is therefore
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

| Task                           | Command                     |
| ------------------------------ | --------------------------- |
| Room server (default :8787)    | `npm run server`            |
| Standalone scoped ACP executor | `npm run runner`            |
| Backend TypeScript             | `npm run typecheck:backend` |
| Backend runtime tests          | `npm run test:backend`      |

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

## Canvas thinking effect

- `InteractiveCanvas` in `apps/desktop/src/components/ui/` is a parent-sized,
  pointer-transparent soft-blue dot field. `CanvasThinkingOverlay` positions it
  over the current local agent targets, without persisting activity in shapes.
- A prompt captures the selected node IDs; successful scoped canvas tools retarget
  the effect. Broad `getCanvas` reads do not light up the entire board. Completion,
  cancellation, disconnection, and sign-out clear it. Reduced motion is static.
- Unit checks: `npm run test -w @kan/desktop` includes target extraction tests.
- From the canvas catalog in `npm run tauri:drive`, run
  `node scripts/agent-thinking.e2e.mjs`. It mounts an isolated fixture, simulates
  agent replies at the IPC fetch boundary, and sends real native canvas events.
  It exercises the actual provider and canvas, but is not live-provider coverage.
  Do not drive concurrently. The script cleans up its fixture and restores fetch
  and media-query handling. Tauri's internal invoke is read-only; Vite context
  imports must retain their HMR query strings to avoid duplicate providers.

## Canvas/chat regression checks

- The tldraw theme in `apps/desktop/src/styles.css` is scoped to UI roots,
  including portaled menus/popovers, not `.tl-container` itself: shared radius,
  font and color tokens also style canvas content. Preserve round swatches and
  handles. `node scripts/canvas-theme.e2e.mjs` checks the native UI theme and
  tool switching with a temporary canvas, then restores the original route.
  Do not drive concurrently.
- `WorkspacePanels` must give its inner canvas wrapper explicit full height;
  panel dimensions alone do not prevent a zero-height canvas and clipped toolbar.
  Keep both panels mounted when collapsing chat to preserve editor and draft state.
- `addNode` supports native `geo` drafts (`geo: "rectangle"` or `"ellipse"`);
  equal ellipse dimensions make a circle. `focusNodes` fits current-page targets
  without changing shape records or selection and is exposed by the Rust MCP bridge.
- `npm run test:desktop` supplies the desktop tsconfig for component-render tests.
  Pure node helpers import runtime validation/schema utilities from `@tldraw/validate`
  and `@tldraw/tlschema`, avoiding browser-runtime timers in Node tests.
- With `npm run tauri:drive` running, `node scripts/canvas-chat.e2e.mjs` checks
  canvas/toolbar visibility, resizing, chat state preservation, native shapes,
  camera focus, and controlled streaming feedback in an isolated canvas. A connected
  agent is required; add `--live` to also exercise the reported prompts with the
  real provider. The script restores the original page and cleans its test canvas.

## Local QA reports

- The bottom-left Report bug dialog freezes diagnostic context when opened.
  `useQaSource` registers canvas, chat, composer, thread view, and agent state;
  closed panels retain a last snapshot marked `mounted: false`. Sources are
  scoped to the route, not collected from credentials, storage, or environment.
- Native `qa_save_report` writes immutable UUID JSON reports and `bugs.csv` to
  this worktree's gitignored `qa_bugs/` in development. Packaged apps use the
  app-local-data `qa_bugs/` directory instead. `KAN_QA_DIR` can override either
  with an absolute path. The success dialog shows the full report path.
- Reports include private canvas/chat text; known credentials and URL queries
  are redacted and embedded assets omitted, but this is not a guarantee that
  arbitrary user text is secret-free. Do not upload or commit reports.
- `/qa-fix` uses `.devin/agents/qa-fable.md` (Fable 5.1 Medium), one foreground
  subagent at a time. `python3 scripts/qa_queue.py list|claim|update` manages
  `open`, `solving`, and `finished` rows, owners, and verification notes.
  Pass `--dir /absolute/qa_bugs` before the command to use another queue.
  Both Rust and Python share `.queue.lock` and atomic CSV replacement; never
  hand-edit the CSV or remove a lock without checking for an active writer.
- Checks: `npm run test:desktop`, `npm run typecheck -w @kan/desktop`,
  `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml qa::tests`, and
  `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p qa_queue_test.py -v`.
- Native regression: `node scripts/qa-report.e2e.mjs` against a running driver.
  Start on catalog/onboarding with a fresh QA queue; it refuses an existing CSV
  and cleans only its fixture reports/canvas. An optional `KAN_QA_DIR` must match
  the app launch environment. Keep the window visible: hidden WKWebViews freeze
  CSS exit animations and can return stale screenshots.
- For simultaneous worktrees, use launch-time Tauri `--config` overrides for
  `identifier`, `build.devUrl`, and `build.beforeDevCommand` (Vite `--port`). Set
  `TAURI_WEBDRIVER_PORT` for the app and `TAURI_WEBDRIVER_URL` for the driver.
  Do not stop or drive somebody else's app on the default ports.

## Online room video

- Every online room entry mounts `RoomPrejoin` before canvas sync or Vonage connects.
  Device previews are local; `Join room` is the publication boundary. The room route
  owns capture so the selected tracks survive the transition, and cancellation or
  leaving releases them. `LocalMedia` cancels stale permission/device requests.
- `useRoomVideo` lazy-loads `@opentok/client` and gets short-lived credentials from
  authenticated `GET /rooms/:id/video-token`. Vonage application secrets stay on
  the room server. Both-off participants still connect and can receive the call.
- `RoomParticipantStrip` sits at the top center of the canvas. Online tldraw users
  use `createUserId(installationId)` to match the identity in Vonage connection
  data; following uses tldraw's native start/stop-following methods.
- Focused media lifecycle checks: `npx tsx --test apps/desktop/test/room-media.test.ts`.
  Live multi-person media and follow-view checks still require two room clients.
- Native call UI regression: `node scripts/call-theme.e2e.mjs` mounts the real
  lobby and participant strip with synthetic media and a controlled subscriber.
  It tests styling, device controls, permission states, retry and narrow layouts;
  it does not contact Vonage or capture real devices. Set `TAURI_WEBDRIVER_URL`
  for an isolated instance and do not drive concurrently.

## Queued bug regressions

- `python3 scripts/qa_queue.py repair` repairs only recognized joined CSV rows,
  validates the entire queue first, and saves the original in a private
  `.bugs-backup-*.csv` file. Use the command rather than hand-editing the queue.
- Structured assistance now supports calendar drafts, including `selectedDate`,
  and a bounded `style` mutation for native geo colors. Offline additions create
  `kan-calendar`; shared `kan-node` calendar drafts reuse the same interactive
  `CalendarView`. Other rich-node types still require shared-schema integration.
- From the catalog after completing onboarding, run
  `node scripts/qa-queue.e2e.mjs` against the Tauri driver. It mounts an isolated
  canvas/chat fixture, tests native color changes, Ask Kan structured completions,
  native/shared calendar controls, and the thread header. Provider replies are
  controlled at the IPC fetch boundary, not live-provider coverage. Do not drive
  concurrently. `TAURI_WEBDRIVER_URL` selects a separately launched QA instance.
- Desktop node schemas remain independently constructed: the desktop and protocol
  currently resolve different Zod versions, so composing their Zod object types
  directly fails typechecking. Keep desktop date helpers importable by the plain
  `node --test scripts/date-nodes.test.mjs` command as well as tsx.
- Backend test fixtures must register server/socket cleanup with `t.after`; an
  assertion before end-of-test cleanup otherwise leaves the pre-push runner open.
  Await `classifierIdle` after debounced human edits before inspecting decisions.
- Classifier persistence failures reject `classifierIdle` while retaining durable
  causes for retry; later jobs must still run. Open suggestions/offers and recent
  resolved contributions have separate bounded context lists so neither crowds
  out the other.

## Agent diagnostics and fault injection

- `packages/protocol/src/diagnostics.ts` defines content-free events and typed
  failures. Desktop traces join frontend, Rust ACP, and native MCP events by
  turn/request IDs. Structured assistant turns use the lease run ID as their
  turn ID. Regular chat/Ask Kan uses structured turns; prompts on an offline
  canvas use the local canvas MCP path. Do not assume a failed Ask Kan request
  used MCP.
- `Report bug` → `View diagnostics` previews/copies the recent trace. Local agent
  entries also expose per-turn diagnostics. QA reports include frozen metadata
  traces. Optional error-stack/stderr capture is memory-only, expires after five
  minutes, and can still contain private text; preview before copying.
- Native metadata logs live under app-local-data `diagnostics/`, with two bounded
  files and private permissions. The runner uses `~/.local/state/kan/diagnostics`
  (override with `KAN_DIAGNOSTICS_DIR`); neither log contains prompts, raw tool
  arguments, result contents, or credentials by default.
- Desktop mutation `requestId` UUIDs deduplicate identical retries within the
  current canvas agent session, including across turns. Conflicting reuse is
  rejected. Deduplication is not durable across process/session replacement;
  inspect the canvas after an unknown outcome rather than blindly replaying.
- Native fault regression: launch an isolated app with
  `DEVIN_BIN="$PWD/scripts/diagnostics-fake-agent.mjs" TAURI_WEBDRIVER_PORT=4449 KAN_QA_DIR=/tmp/kan-diagnostics-qa npm run tauri:drive -w @kan/desktop -- --config '{"identifier":"com.asierzapata.kan.diagnostics-qa","build":{"devUrl":"http://localhost:1426","beforeDevCommand":"npm run dev -- --port 1426"}}'`.
  Complete onboarding with the fixture subscription provider, then run
  `TAURI_WEBDRIVER_URL=http://127.0.0.1:4449 node scripts/agent-diagnostics.e2e.mjs`.
  It refuses a real provider, uses actual ACP/MCP subprocesses and native IPC,
  injects result-delivery faults, and exercises both tool and structured paths.
  It cleans its canvas and leaves its report in the isolated QA directory.
- Dynamic test harness imports must preserve Vite's `?v=` dependency hashes as
  well as HMR queries. Resolve React/ReactDOM URLs from transformed `src/main.tsx`;
  importing bare optimized-dependency URLs can create a second React dispatcher.
- Focused tests: `npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/test/agent-diagnostics.test.ts`,
  `npx tsx --test apps/agent-runner/test/diagnostics.test.ts`, and
  `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.

## Live room transcription

- Vonage captions start after microphone publication, through authenticated
  `POST /rooms/:id/captions`. The moderator token stays server-side; client video
  tokens remain publishers. The existing Vonage SDK creates routed sessions and
  enables partial captions by default. `VONAGE_CAPTION_LANGUAGE` selects the call
  language on the server (default `en-US`); this is not automatic language detection.
- Each client subscribes only to its own published stream for captions, using a
  detached subscriber with audio/video reception disabled. Only that speaker
  relays partial/final text through the authenticated events socket. The server
  assigns the author, so muted listeners receive all transcripts without duplicate
  writes. This path transcribes speech published by Kan clients, not external SIP
  participants or other clients that do not relay their own captions.
- Partials are ephemeral, replaced in place, and cleared on disconnect or after
  15 seconds without an update. Only finals become durable `message` entries with
  `source: "transcript"`; the UI maps those to collapsed transcript runs. Finals
  use stable UUIDs and an in-memory retry queue across socket reconnects, not a
  durable offline outbox. New captions do not open a collapsed run, and the thread
  keeps the reader's expansion state independently of run grouping.
- Caption-service starts are coalesced and refreshed every minute while publishing
  audio, including after reconnect. Vonage ends captioning 60 seconds after the
  last Video client disconnects. Retrying transcription does not restart media.
  Deploy the room server and desktop together: old servers do not understand the
  new transcript socket messages. Vonage live captions are usage-billed.
- Focused checks: `npx tsx --tsconfig apps/desktop/tsconfig.json --test
  apps/desktop/test/transcription.test.ts apps/room-server/test/transcription.test.ts`.
  These cover controlled SDK events, rendering, real HTTP/WebSocket transport,
  replay, attribution, and room isolation, not live-provider speech recognition.
- A captions-only subscriber with `insertDefaultUI: false` must pass `undefined`
  as the target element. Supplying even a detached div is rejected by OpenTok.js
  before subscription (`OT_INVALID_PARAMETER`, code 1011). Keep the SDK option
  compatibility assertion in the transcription test; an unconstrained mock missed
  this integration failure.

## Thread panel header

- The header is one row: `Thread` badge, channel, the assistant chip, search,
  close. The three-way filter tabs (Everything / Messages / Agent activity) are
  gone; `buildThreadRows(entries, search, view)` takes a search query instead,
  matched by `matchesSearch` over body text plus anchors, attachments, agent
  step summaries, suggestion quotes and offer titles. Contextual and propose
  triggers are now always hidden, since only the deleted tab revealed them.
- `AssistantMenu` (`components/thread/AssistantMenu.tsx`) is the single
  assistant control. Scope, eagerness, background checks and the room pause all
  live in it. `lib/assistant-settings.ts` collapses scope+eagerness into one
  `ChimeIn` ladder (`asked` = `scope: "manual"`, then the four eagerness
  levels). It derives rather than migrates: `kan-assistant:<roomId>` and the
  server's `assistantEagerness` keep their existing shape. Whose triggers the
  agent runs (`own` vs `room`) stays a separate switch, shown only online.
- Assistant settings are read at **first render**, not restored in an effect.
  A reader effect and the writer effect run in the same commit, so the writer
  persisted the defaults over the restore and StrictMode's second pass read
  those defaults back: every setting reverted on reload. Room changes reset the
  state during render for the same reason.
- `ThreadPanel` has three slots: `headerAction` (the chip), `status` (one
  transient line, rendered only when non-empty: agent busy with Cancel, then
  errors) and `footerStatus` (ambient state such as the call transcript). Do
  not put always-set text in `status` or the slot becomes permanent. The old
  `toolbar` slot went away with the conversation simulator that used it.
- `lib/config.ts` treats a blank `VITE_*` key as absent. Vite injects `""` for a
  key present but empty in `.env.local`, and the old `.min(1).optional()`
  crashed the whole app on boot over an optional key.

## App icon packaging

- `apps/desktop/src-tauri/icons/Kan.icon` is the editable Icon Composer source.
  Tauri CLI 2.11.4 compiles it into `Assets.car` and sets `CFBundleIconName`
  during macOS bundling; keep `icon.icns` alongside it for older macOS versions.
  Native icon compilation requires full Xcode 26+ with first-launch components
  installed; verify with `xcrun actool --version`.
- Run `node scripts/generate-icons.mjs` on macOS after changing the artwork.
  It regenerates the macOS fallback through `actool` and desktop PNG/ICO sizes
  through Tauri from `icons/source.png`, the flattened Composer PNG export.
  Update that export too when the design changes. Mobile outputs stay temporary.
- For an icon-only update to an already-built alpha, run
  `npm run tauri -- bundle --bundles app,dmg --config '{"productName":"Kan Alpha","identifier":"com.asierzapata.kan.alpha","bundle":{"macOS":{"signingIdentity":"-"}}}'`.
  This repackages the existing release executable; it does not compile current
  source. Use `build` instead of `bundle` for a fresh full build. Outputs live in
  `apps/desktop/src-tauri/target/release/bundle/`. Ad-hoc signing is not notarization.
- Verify both `CFBundleIconFile` and `CFBundleIconName` in the packaged plist,
  inspect `Assets.car` with `xcrun assetutil --info`, verify the signature with
  `codesign --verify --deep --strict`, and launch the actual `.app` to check the
  macOS icon. A dev WebDriver window does not exercise packaged icon resources.
