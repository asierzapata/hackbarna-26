# Kan onboarding, installation identity, and canvas lifecycle

Implementation handoff · 2026-09-19 · Plan only; no application changes made.

## 1. Goal and settled product decisions

Implement the first installation experience and the normal return experience for Kan. This document incorporates the user's explicit corrections to the earlier discussion. In particular, **online canvases remain editable and synchronize across participants**.

Required behavior:

1. On first launch, ask for the user's display name. No email, password, OAuth, or account creation screen.
2. Generate and persist one stable installation identity locally. Associate the name and local canvases with that identity.
3. Create and open the first offline canvas without needing the backend or internet.
4. Explain that the canvas is local and that making it online enables sharing and live collaboration.
5. Making a canvas online converts that canvas permanently to backend persistence and participant sync. It does not publish a frozen snapshot or leave an independently editable offline original.
6. An online canvas can be duplicated into a new, independent offline canvas. This does not change the online source.
7. After onboarding, ordinary launches open the list of offline and online canvases.
8. Defer backend identity creation until the first operation that needs it: publishing or joining another person's room. Simply launching, onboarding, and editing offline must not register a user.

An installation is the identity boundary for v1. A second installation gets a different identity, even if its display name is identical. Names are not unique identifiers. Cross-device identity recovery, account linking, and sign-in are out of scope.

## 2. Repository baseline and coordination

Read `AGENTS.md`, `ARCHITECTURE.md`, and the latest code before implementing. Two agents are concurrently implementing the backend and frontend integration. Files observed below are a moving snapshot, not a promise that they remain unchanged.

Observed current implementation:

| Area | Current state | Consequence |
| --- | --- | --- |
| `apps/desktop/src/routes/index.tsx` | `/` redirects to a newly generated room UUID on every visit | Replace with onboarding/return routing; do not keep generating canvases on launch |
| `apps/desktop/src/routes/room.$roomId.tsx` | Owns workspace, providers, canvas, thread, call | Reuse this composition with explicit local/online resolution |
| `apps/desktop/src/components/Canvas.tsx` | Uses `kan-room-${roomId}` local tldraw persistence and seeds demo shapes into empty boards | Preserve storage compatibility; remove production demo seeding |
| `apps/desktop/src/lib/room-transport.ts` | Thread transport seam and wire-to-view adapter | Reuse the integration agent's actual transports |
| `packages/protocol/src/index.ts` | Already defines installation-style registration, room creation/import, joining, and user/room schemas | Import schemas and types; do not create competing contracts |
| `apps/room-server/src/http.ts` | Registration, `/me`, room list/create/join/detail/open, assets, canvas, socket tickets | Most necessary backend endpoints already exist in working code |
| `apps/room-server/src/engine.ts` | Registration retries reuse an identity; publish retries reuse a room by creator + local canvas ID | Build recovery around these guarantees |

The architecture's shared-secret/no-accounts prose predates the current installation credential endpoints. Retain its collaborative sync architecture; use the current agreed protocol for identity. Update that documentation once implementation lands.

### Ownership agreement before edits

| Work | Suggested owner | Shared boundary |
| --- | --- | --- |
| Identity endpoints, membership, durable/idempotent room creation | Existing backend implementer | Confirm schemas, responses, failure semantics |
| Online editor store, thread transport, assets, connection lifecycle | Existing frontend integration implementer | Expose online workspace and publish/import adapters |
| Local profile, onboarding state, welcome UI, canvas catalog, return routing | Onboarding implementer | Reuse storage and workspace services if already added |
| Publish UI and recovery coordinator | One explicitly chosen frontend owner | Do not implement a second publish coordinator |

Before starting, inspect `git status` and re-read any files that changed since this plan. Preserve unrelated work. Agree on ownership of `index.tsx`, `room.$roomId.tsx`, `Canvas.tsx`, and `HeaderBar.tsx`. Do not replace these files wholesale or rewrite the integration agent's services. Coordination is required, but this handoff itself does not authorize sending messages to other tasks.

## 3. Identity model and backend contract

Use one UUID for the installation identity and the backend `userId`; a separate installation-to-user table is unnecessary for v1. The frontend may call it `installationId` but must map it explicitly to `userId` in requests.

Generate once, with cryptographic randomness:

- `installationId`: `crypto.randomUUID()`.
- `secret`: 32 random bytes encoded as 64 lowercase hexadecimal characters, matching `RegisterInput`.
- `name`: trimmed, nonempty, maximum 80 characters, validated with the shared schema after trimming.

The secret is an invisible installation credential already required by the backend, not a user-entered password. Keep it out of room links, logs, analytics, canvas exports, and UI. Persist identity before sending registration; never regenerate credentials on network failure or reload.

Current contracts to reuse and reverify:

| Operation | Contract |
| --- | --- |
| Register | `POST /users/register` with `{ userId, secret, name }`; response `{ user: { id, name } }` |
| Authenticate | `Authorization: Bearer <userId>.<secret>` |
| Inspect identity | `GET /me` |
| Rename identity, if needed | `PATCH /me` with `{ name }` |
| List memberships | `GET /rooms` → `{ rooms }` |
| Publish | `POST /rooms` with `{ localCanvasId, name, records?, messages?, assetIds? }` → `{ room, created }` |
| Join | `POST /rooms/join` with `{ code }` |
| Room detail/open | `GET /rooms/:id`, `POST /rooms/:id/open` |
| Read document for duplication | `GET /rooms/:id/canvas` → `{ records }` |

`ensureBackendIdentity()` must deduplicate concurrent calls and persist success. Repeat registration with the same credentials is safe. Current registration returns the existing name on retry; it does not rename an existing user. Do not silently assume otherwise. Profile editing UI can wait; if name editing already exists, synchronize through `PATCH /me` with explicit pending/error state.

Registration success followed by publish failure is valid: the identity can remain registered while the canvas remains local. A credential conflict must not trigger identity replacement or strand the user's existing memberships. Present a recoverable error and preserve local data.

Persist registration state per backend origin/environment, or invalidate its cache when that origin changes. A boolean from one development server cannot establish registration on another.

## 4. Local persistence and service boundaries

Reuse the frontend agent's persistence layer if one exists. Otherwise, use a versioned IndexedDB repository for profile, canvas metadata, and operation journals; retain tldraw's existing persistence mechanism for document data. Keep storage behind async services so React components do not perform ad hoc storage writes. If a native credential store is already provided, use it for the secret and keep only its reference in the profile; do not introduce a second identity implementation.

Suggested logical records (names are illustrative, semantics required):

```ts
type InstallationProfile = {
  schemaVersion: 1;
  installationId: string;
  name: string;
  credentialRef: string; // or private repository-managed credential
  createdAt: string;
  onboardingVersion: number;
  firstCanvasId: string | null;
  onboardingCompletedAt: string | null;
  sharingHintDismissedAt: string | null;
};

type CanvasCatalogEntry = {
  id: string; // stable local catalog id, never a display name
  name: string;
  mode: "offline" | "online";
  localPersistenceKey?: string;
  roomId?: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
};
```

Use a separate persisted publish journal with local canvas ID, backend origin, stage, frozen payload reference, asset mapping, and known result room ID. Treat `publishing` and `reconciling` as operation states rather than new durable canvas modes. Cache online room summaries separately from authoritative local entries if that simplifies reconciliation.

Recommended services:

- `identityRepository.getOrCreate()` and `ensureBackendIdentity()`.
- `onboardingService.completeWithFirstCanvas(name)`; idempotent and resumable.
- `canvasRepository.createOffline()`, `listLocal()`, `resolve()`, `markOnline()`.
- `canvasSnapshotService.exportDocument()`, `importDocument()`, asset conversion helpers.
- `publishService.publish(localCanvasId)` and `resumePendingPublishes()`.
- `duplicateService.duplicateOnlineToOffline(roomId)`.
- Existing typed backend client and online room service.

Do not maintain two writable copies of one canvas. Local recovery bytes may remain temporarily after conversion, but must not appear as an editable offline canvas. Clean them up only after the online mapping is durable and server state is verified.

### Atomicity and recovery

Profile metadata and tldraw persistence may live in separate databases, so do not claim a single transaction covers both. Reserve and persist `firstCanvasId` before initializing the document. Retry initialization for the same ID after interruption. Mark onboarding complete only after the document is durably initialized and its catalog entry exists. Use a transaction for related repository metadata where possible.

Handle quota/write failures visibly; do not navigate away as if onboarding succeeded. A double click, React StrictMode, route reload, or second window must not create a second identity or first canvas. Use transactional uniqueness and cross-window operation coordination where necessary; a component-local flag alone is insufficient.

## 5. Routes and launch behavior

Recommended route structure, adapted to any routes already introduced by the integration agent:

- `/`: bootstrap persisted state; redirect incomplete profiles to `/onboarding`; otherwise render the canvas list.
- `/onboarding`: welcome/name form; completed profiles redirect home unless an interrupted bootstrap needs recovery.
- `/canvas/$canvasId`: local canvas route, if adding an explicit local route fits existing integration.
- `/room/$roomId`: online room workspace.

If keeping one workspace route instead, resolve mode from the catalog explicitly. Never infer online status merely from an ID being a UUID. Do not treat an unknown route ID as permission to create or publish a new canvas.

Normal return launch opens the list. Explicit canvas links remain navigable. An invite opened before onboarding should preserve a validated pending destination locally: collect the name, initialize the first offline canvas consistently, then resume the invite instead of losing it. Joining requires lazy registration even if the user has never published. This is an inferred edge-case policy, not a requirement to build native deep-link plumbing in this task. Reuse existing invite handling; show a join-by-code action if that is the current supported entry point.

Bootstrap renders a small loading state until storage is loaded, avoiding a flash of onboarding or a randomly generated room. Unknown/deleted local IDs get a clear not-found state and a link to the list. Missing membership and network failure must have distinct online error states.

## 6. Welcome and first canvas experience

Keep the welcome screen to one step:

- Title: “Welcome to Kan”.
- Prompt: “What should we call you?”
- Labeled display-name input with autofocus and Enter submission.
- Supporting text: “Your name is shown to others when you collaborate.”
- Primary action: “Start creating”.

Reject whitespace-only input; trim leading/trailing spaces while preserving interior spacing and international names. Show inline validation and storage errors. Disable repeated submission while completing local initialization. No backend request, agent login, camera permission, or microphone permission is required.

Create a blank canvas named “My first canvas”. Reuse ordinary offline creation so onboarding does not have a special document format. Demo shapes and fake participant/thread activity must not appear in real new canvases or reappear when a user intentionally empties a canvas.

After opening the canvas, show a lightweight, dismissible introduction near the sharing control:

> This canvas is saved on this device. Make it online to share it and edit together. Once online, it stays online. You can always make a separate offline copy.

Actions: “Got it” and optionally the existing “Make online” action. Persist dismissal separately from onboarding completion. Dismissing, ignoring, or never publishing must not prevent completion. The explanatory UI must not block drawing or be inserted as a permanent canvas shape.

Make a visible “Canvases” navigation control available in the workspace. Reuse current design tokens and shadcn primitives; read the repository's shadcn skill before implementation. Include keyboard access, visible focus, accessible labels, and focus restoration for dialogs. Respect the app's minimum window dimensions.

## 7. Canvas list after onboarding

Render local results immediately; fetch online memberships only if this installation is already registered with the configured backend. Do not register merely to display an empty online section.

Use two clearly labeled sections, “Offline” and “Online”, with name, mode, and last-opened or updated time. Recommended default ordering: recently opened first, deterministic fallback by creation time/ID. Actions:

- “New canvas”: create a durable blank offline canvas and open it.
- Open existing offline or online canvas.
- “Join canvas”: use existing join-by-code/invite flow; register lazily.
- “Make online” for an offline canvas.
- “Duplicate offline” for an online canvas.

Offline catalog entries are authoritative locally. Online names and memberships come from the backend; cache successful responses for disconnected display. A failed fetch must not erase cached online rooms or local canvases. Distinguish loading, empty, stale/disconnected, and error states. Online rows should remain online when the network is unavailable.

Merge a published local entry and the matching server room into one online item using the returned mapping; do not show both entries. Reconcile owned rooms by creator identity plus `localCanvasId`, and joined rooms by `roomId`. The backend room ID is different from the original local canvas ID.

Rename/delete/archive/search can reuse existing functionality but are not prerequisites for this handoff. Do not expand into a full library redesign.

## 8. One-way publishing and recovery

Publish confirmation:

> **Make this canvas online?**
> Your canvas will be saved online so you can share it and edit together. It will stay online. You can duplicate it into a separate offline canvas anytime.

Actions: “Keep offline” and “Make online”. Do not say “read-only”, “freeze”, or “you won't be able to edit”.

Required sequence:

1. Acquire an operation lock for this local canvas across relevant windows. Check whether it is already online or has an unfinished publish.
2. Temporarily prevent document and local thread mutations while capturing/importing. Explain progress; this is a transient operation lock, not online read-only behavior.
3. Flush pending local persistence, capture document-scoped records and supported local human messages, and durably journal the frozen payload. Exclude editor session state, camera/selection state, fixture entries, and invented server sequence numbers.
4. Ensure backend identity using persisted credentials.
5. Upload local assets through the existing asset service; rewrite the exported payload to server-resolvable asset references. Persist mappings for retries. Never publish `blob:` or device-only URLs and assume other participants can open them.
6. Validate the payload against the shared schemas and current request limits. The inspected protocol allows up to 5,000 records, 500 messages, and 100 asset IDs; HTTP currently limits JSON bodies to 8 MiB. Recheck these limits rather than duplicating constants. Do not silently truncate content.
7. Send `POST /rooms` with the original stable `localCanvasId`. The backend currently returns the original room on repeated publication by the same creator, without replacing its live document.
8. Persist the returned `roomId`, online mode, and completed journal atomically in the local repository. Retire the offline catalog entry as an editable source.
9. Mount the integration agent's synchronized online workspace with a fresh editor lifecycle, using server state. Close the local transport and store subscriptions.
10. Show online/share controls and enable collaborative edits. A sync connection failure after acknowledged creation leaves the canvas online with reconnect UI.

### Failure rules

| Failure point | Required behavior |
| --- | --- |
| Before room creation request is dispatched | Keep offline data; allow retry or return to editing; restart export if edited |
| Explicit server rejection proving creation did not commit | Show actionable error; preserve data and return to offline editing |
| Timeout/disconnection after dispatch, generic server error, or app crash | Treat outcome as unknown; persist recovery state and reconcile before allowing source edits |
| Server created room, but response/local mapping was lost | Retry same idempotent publish or find owned room by original local ID; commit mapping to that room |
| Server acknowledged room, but sync is unavailable | Remain online; reconnect; never reopen the original as writable offline |
| Local mapping write fails after server success | Keep journal and source recovery bytes; retry local commit; no second room or writable original |

An ambiguous network failure is **not evidence that the canvas remains offline**. Reusing the same frozen request and identity is essential. If connectivity is unavailable, show “Checking whether your canvas is online” with retry/back-to-list; do not silently unlock the potentially converted source. A separate explicit offline duplicate can be offered as recovery, clearly a new canvas.

After successful reconciliation, fetch/mount current server state, not the original publish snapshot: participants may already have edited the room. Coordinate with the backend owner to confirm concurrent duplicate requests are also handled safely and that documented errors really imply rollback.

## 9. Online behavior and offline duplication

Online means server persistence, shared editable document state, shared thread, and the existing participant/sync model. This task must not add permanent read-only flags to online stores. Calls and agents remain governed by existing integration behavior.

Online editing while fully disconnected is not specified by the user. Follow the integration agent's sync behavior; do not promise durable offline edits to an online room unless implemented and verified. Connection loss must never change canvas mode.

For “Duplicate offline”:

1. Obtain a consistent current document snapshot from the server or confirmed synchronized store. If using stale cache, explicitly label it as a cached copy; default to requiring a current snapshot.
2. Download and persist all required asset bytes so the copy works without network access. Authorized remote asset URLs alone are not an offline copy.
3. Allocate a new local canvas UUID/persistence key and name it “<name> (copy)”. Preserve internal document references; IDs may remain within a separate store if supported, otherwise remap shapes, bindings, pages, and anchors together.
4. Initialize document storage and catalog with resumable/transactional logic; only report success once durable.
5. Open the new offline canvas. The original room remains unchanged and collaborative.

Default duplication scope is canvas content and assets, without copying the shared thread, membership, room code, credentials, or executable agent session state. This scope is a proposed v1 default. Existing offline human messages should be imported during publication when supported; do not fabricate imported agent history. Inspect provenance references when duplicating and render unresolved source links gracefully instead of treating them as local thread IDs.

## 10. Migration and compatibility

Existing development canvases use `kan-room-${roomId}`. Preserve these keys when adopting an accessible existing local canvas into the catalog. Do not rename or delete its IndexedDB database blindly.

If a legacy ID is known from the current route, register that local canvas without overwriting its content. Do not promise automatic discovery of every historical random ID: there is no observed persistent catalog, and database enumeration must be verified before using it. A legacy install lacking a profile can still ask for a name; avoid destroying existing documents during first-canvas setup.

Version all new records and validate reads. Corrupt or partially written data should produce a recoverable state, not automatic deletion. Preserve installation identity across normal launches, updates, and transient backend failures. Reinstallation behavior depends on whether app data survives; never claim identity survives deleting app data.

## 11. Implementation sequence and suggested files

These filenames are suggestions; reuse equivalent modules already landed by the other agent.

1. **Reconcile contracts and ownership.** Read current identity, canvas storage, API client, route, and asset implementations. Record which services are reused and any missing backend behavior.
2. **Implement persistence foundation.** Add or extend `src/lib/installation-profile.ts`, `src/lib/canvas-repository.ts`, and operation journals. Verify identity and first-canvas idempotency with focused tests.
3. **Implement local bootstrap.** Add `src/lib/onboarding.ts`; make name submission reserve/create the same first canvas on retry. No server dependency.
4. **Implement welcome and return routes.** Add `src/routes/onboarding.tsx`, update `index.tsx`, and add catalog UI components. Wire workspace navigation with the integration owner.
5. **Remove production fixture seeding.** Keep demo content behind explicit development/demo entry points. Confirm clearing a real canvas leaves it empty after reload.
6. **Wire lazy identity.** Add or reuse `src/lib/identity-client.ts`; call it only from online operations and recovery. Use real profile names throughout local thread/current participant rendering.
7. **Implement publish orchestration.** Add or extend `src/lib/publish-canvas.ts`; reuse snapshot, asset, and online mounting services. Implement ambiguous-outcome recovery before calling publish complete.
8. **Implement list reconciliation and joining.** Cache memberships, deduplicate converted canvases, preserve pending invite intent, and expose reconnect/error states.
9. **Implement offline duplication.** Add or extend `src/lib/duplicate-canvas.ts`, including asset portability and independent document persistence.
10. **Verify and document.** Follow the test matrix below, then update architecture/README with identity and one-way mode semantics. Provide a concise implementation report and actual evidence.

Keep backend changes with its owner where possible. If a required capability is absent, state its exact missing contract rather than adding a mock and presenting the flow as finished.

## 12. Verification and acceptance criteria

Read `.agents/skills/e2e/SKILL.md` before verification and use the real Tauri driver. Use isolated test app data and a disposable backend database/identity; never clear the user's active installation to simulate first launch. Do not stop another agent's running app or take its fixed ports without coordination.

Focused automated tests should cover meaningful state transitions:

- Stable identity across reinitialization, concurrent initialization, and failed registration.
- Name normalization/validation with Unicode, whitespace, empty, and over-limit values.
- First-canvas initialization interrupted at each persistence boundary; retry creates one canvas.
- Registration repeated with identical credentials and conflicting credentials.
- Publish repeated/concurrent requests create one room; payload retry cannot overwrite later online edits.
- Publish response lost, local commit failure, crash recovery, and explicit rejection.
- Catalog reconciliation does not duplicate converted canvases or erase rows on fetch failure.
- Duplication produces an independent durable document and local asset references.

Required running-app scenarios:

| Scenario | Acceptance evidence |
| --- | --- |
| Fresh installation, backend stopped | Name form opens; valid submit opens blank offline canvas; no registration request |
| Invalid name and repeated submission | Accessible inline validation; exactly one first canvas and identity |
| Offline edits followed by reload/restart | Content persists; ordinary launch shows list, not welcome or new UUID |
| First-canvas sharing hint | Correct collaborative copy; dismiss persists; drawing remains possible |
| Emptying a canvas | No demo content returns on reload |
| First publish | User created once with chosen name; content/assets/messages preserved as supported; one online catalog row |
| Second isolated participant joins | Actual names displayed; edits from each participant appear in the other editor |
| Backend restart | Room content and memberships survive and reconnect |
| Publish timeout/crash after server commit | Recovery resolves to same room; original does not become writable offline |
| Sync failure after publication | Online status preserved; reconnect UI shown |
| Duplicate online to offline | New independent local canvas; assets render with backend/network unavailable; source unaffected |
| Returning without connectivity | Offline list/editing works; cached online rows show connectivity state |
| Join before ever publishing | Lazy registration occurs once; membership appears in online list |
| Legacy local canvas | Adoption preserves existing content and persistence key |

Start via `npm run tauri:drive`, follow the skill's readiness/log checks, and drive with `node scripts/drive.mjs snapshot`, `eval`, `clickText`, `fill`, `reload`, and `shot`. Inspect screenshots of welcome, first-canvas hint, list, publish confirmation, and online workspace. For two participants, use separate identities/data stores; two tabs sharing storage are not two installations. At least one participant must be the real Tauri app; report if the peer is a browser and what that does not cover.

Run `npm run typecheck`, relevant workspace tests, and `npm run build` as required by changed scope and repository hooks. Passing builds do not replace the running-app evidence. Do not write tests that merely assert CSS classes or mirror implementation internals.

## 13. Implementer delivery checklist

- All settled behavior in section 1 is implemented without email/OAuth screens or permanent online read-only behavior.
- Existing backend and frontend work is reused, with overlap and contract changes documented.
- Offline initialization is independent of network availability.
- Installation credentials and first canvas survive retries and restarts.
- Publish is one-way, idempotent, and recoverable under an unknown server outcome.
- Online collaboration is observed from two distinct identities.
- Offline duplication includes portable assets and does not mutate the source.
- Return launches show the catalog; explicit links preserve navigation intent.
- No unrelated working-tree changes are overwritten; no user storage is cleared.
- Final report lists changed behavior, commands/results, e2e observations/screenshots, and any skipped checks or remaining limitations. Do not claim completion based only on compilation.

Suggested handoff instruction: “Implement this plan against the latest working tree. First reconcile ownership and reuse the backend/frontend integration already underway. Treat section 1 as the product contract, and the named files as suggestions. Complete the failure-recovery and real-app verification steps before reporting the feature done.”
