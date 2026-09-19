# Kan — overnight cloud implementation and verification brief

## Mission and scope

Make the three-stage conversation in `KAN_DEMO_README.md` succeed reliably in the real app: **dates → venue → sponsors**. Enric and Juanjo must be able to speak naturally in the same room/canvas, see each other on video, and see the AI create, revise, annotate, shortlist, and discard canvas content.

**Non-negotiable:** the correct canvas change must be visible to both participants within **3,000 ms of the end of the relevant spoken utterance**. A spinner, transcript, tool request, or “working on it” message does not count. (reduce thinking? make explicit in the ui what the agent is doing so it feels like less time)

These two Markdown files are a planning handoff, not evidence that the behavior already works. No implementation or app verification was performed when writing them. Work tonight in an isolated cloud checkout/branch; do not interfere with the presenters’ current local work, app instances, or user data. Do not add a fourth demo stage or redesign unrelated features.

## 1. Establish the real path before changing code

Read the current branch’s `AGENTS.md`, `ARCHITECTURE.md`, and `.agents/skills/e2e/SKILL.md`. Re-read them in the cloud; parallel work may have changed the implementation.

Trace the entire production path:

**Two microphones → speech recognition with participant identity → shared conversation → server-side opportunity detection/assistant → validated canvas tools → shared room state → rendered result on both clients.**

- Identify the assistant the presenters called **Jeff / JJEV**; the name is unconfirmed. Find the actual trigger/decision code rather than inventing a new service around the name.
- Check whether voice currently feeds that path automatically or only fills a composer that still needs Send. This demo requires automatic conversation handling.
- Check online support for every required node and mutation. The repository guide describes local rich-node tools separately from shared room schemas; later notes mention shared calendars but warn other rich nodes still need integration. Do not treat an offline demo as proof of collaborative maps/charts/logos/notes.
- Verify two independent participants, attribution, and one authoritative action per conversational event. Both clients hearing an event must not create duplicate nodes or independent conflicting agents.
- Verify microphone permissions, video, and echo prevention. Muting the video-call audio path must not silently mute AI input. If independent routing is unavailable, use a tested headset arrangement and amend the presenter setup explicitly.
- Confirm real provider credentials/services are available through the normal secure setup. Never copy credentials into fixtures, screenshots, logs, or the handoff. Escalate missing access rather than replacing live behavior with an undisclosed mock.

## 2. Implement only the required visible behavior

Use the exact spoken lines in the companion script as the primary acceptance scenario. Support natural paraphrases too; do not hard-code a timed performance to those exact strings.

| Step | Required state and assertions |
| --- | --- |
| Start | Two participants in the same room, both video tiles visible, voice active, clean test-owned canvas. |
| “Decide the date” | Exactly one calendar for **2026-09**, initially with no selected date or scheduled hackathon. It appears without an explicit “create a calendar” command. |
| Juanjo proposes the 26th | Update that calendar to select **2026-09-26**. Preserve its identity. |
| Enric changes to the 19th/20th | Replace the proposal with a two-day event spanning **2026-09-19 through 2026-09-20 inclusive**; remove the stale 26th selection/proposal. Preserve the calendar identity. Add one small connected La Mercè note. |
| Glovo proposed | Create one map and resolve the intended **Glovo Yellow Park / Glovo HQ, Barcelona** location. Do not choose an unrelated similarly named business. |
| Norrsken preferred | Update the same map, add/focus **Norrsken House Barcelona, Passeig del Mare Nostrum, 15**, and retain Glovo as an alternative. No duplicate map; no false booking confirmation. |
| Venue discussion | Attach compact notes to the map/venue context: capacity, pros/cons, and questions about availability. Capture new remarks incrementally rather than replacing the previous context. |
| Juanjo uploads CSV | Use the real upload UI and parser. Create a readable chart with correct names, EUR values, logos, and text summary; no manual tool calls to manufacture its result. |
| Shortlist Preply and SLNG | Update both candidates in the existing chart; keep their identities and values. |
| “Discard that one,” after naming Coca-Cola | Resolve the reference to Coca-Cola only. Cross it out with an accessible Discarded label and exclude it from the active shortlist/total, or remove it from the chart. Freeze one treatment for rehearsal. |
| Finish | Both clients show the same decisions and annotations. Reconnect/reload must not resurrect discarded or superseded choices. |

### Notes are part of the demo, not decoration

- Create real connector/binding relationships to the relevant parent node. Notes remain legible and nearby when the parent moves; no overlapping stacks, dangling links, or orphan notes.
- Calendar note: **“La Mercè: Barcelona public holiday on Thu 24 Sep; we chose 19–20 Sep to avoid that weekend.”** Preserve the difference between the holiday fact and the team’s scheduling preference.
- Glovo note: **“~200 people — speaker estimate, unverified.”** Do not turn the spoken estimate into a sourced fact.
- Norrsken: record verified capacity for the intended room/layout with a compact source, or **“Capacity to confirm.”** Event attendance is not capacity. Verify both venues before rehearsal if numbers will be spoken.
- Capture “Glovo is familiar” / “Norrsken offers a new setting” as discussion points, not researched facts. Availability remains unknown until confirmed.
- A correction updates existing content; retries and duplicate transcripts must be idempotent. Late research or slow earlier turns must not overwrite the latest decision.

## 3. Prepare and test the sponsor fixture

Use the included `demo-sponsors.csv` in the isolated demo/test workspace, exercise the actual upload flow, and place the tested copy on Juanjo’s machine before the demo. Recheck it immediately before presenting; do not introduce an untested last-minute variant. The CSV has been created but has not yet been validated through the app.

Included fixture (adapt the columns to the real importer while retaining their meaning):

```csv
id,company,estimated_sponsorship_eur,status,data_kind
preply,Preply,12000,candidate,synthetic_demo
slng,SLNG,8000,candidate,synthetic_demo
vonage,Vonage,15000,candidate,synthetic_demo
cognition,Cognition,10000,candidate,synthetic_demo
nebius,Nebius,9000,candidate,synthetic_demo
coca-cola,The Coca-Cola Company,7000,candidate,synthetic_demo
```

- Chart title: **“Sponsor candidates — illustrative sponsorship estimates (EUR)”**. These values are invented fixture data, not company revenue or confirmed contributions.
- Preply, SLNG, Vonage, Cognition, and Nebius are listed on the official 2026 event page linked in the companion script. Coca-Cola is a deliberate fictional candidate, not an asserted event sponsor.
- Resolve and preload permitted logo assets for these candidates; retain readable company names if an asset fails. External logo requests must not block the chart.
- A reasonable interaction model is `candidate → shortlisted` or `discarded`. Keep status semantics consistent between chart styling, selection, summary, and totals.
- Assert parsed values, category-to-logo/name mapping, and status changes. If showing a shortlisted total, Preply + SLNG is **EUR 20,000**; discarding Coca-Cola must not alter those two values.
- Uploading a file twice must not accidentally duplicate the chart. Test a malformed file as a focused regression without adding that case to the live performance.

## 4. Make the two-second target measurable

Instrument each utterance with a correlation ID and timings for audio end, final transcript, trigger/decision, tool completion, shared-state delivery, and rendered result on **each** client. For CSV upload, start at the user’s final file-selection/upload confirmation, not after parsing or network transfer finishes.

**Acceptance latency = later of the two correct visible renders − end of the spoken utterance.** Use synchronized clocks or a single test controller’s monotonic clock; do not subtract unrelated client clock readings. Measure every scripted action, including date corrections, spoken-note updates, shortlisting, and discard.

- Collect at least three consecutive full live rehearsals. **Every critical transition in all three must be ≤2,000 ms**, with no missed actions. Report per-step samples, sample count, median, p95, and maximum; an average alone is insufficient.
- A transcript-to-tool timer is diagnostic only, not end-to-end success. Assert the correct visible state, not just that a backend mutation occurred.
- Preload ordinary assets, connections, verified location data, and small sourced fact caches as part of a disclosed preflight. Keep decisions speech-driven; do not seed the final canvas or use hidden scheduled mutations.
- New internet research must not block a calendar/map correction or a note capturing what a person just said. Render that change first, then enrich with sourced results. Treat enrichment as a separate measured event; do not claim a pending lookup is a finished researched note.
- If mandatory live research cannot meet the timing target, flag it. Agree on disclosed cached facts or simpler content before changing the promise; do not quietly relax the two-second gate.
- Investigate endpointing delay, unnecessary debounce, sequential model calls, queueing, and rendering. Preserve validation, authorization, and correctness while reducing latency.

## 5. Build an end-to-end test, then iterate until it passes

### Automated regression path

Create a reusable test for the full three-stage scenario, following existing repository conventions. Use an isolated room and temporary data; clean up only test-owned artifacts.

1. Connect two distinct clients to the same real room/server and verify convergence.
2. Replay attributed Enric/Juanjo turns through the conversation ingestion boundary. Assert each intermediate state, stable parent IDs, exact counts, connectors, and final agreement. This is a deterministic integration test, not microphone coverage.
3. Exercise the real CSV upload UI. Check values/logos/labels, shortlist selection, pronoun resolution, discard behavior, and totals on both clients.
4. Include duplicate/finalized transcript delivery, correction while an earlier action is in flight, a paraphrased turn, and a harmless non-action remark. Assert no duplicates, stale reversions, or unsolicited nodes.
5. Reconnect a client and verify persisted decisions. Test locale/date handling with an explicit September 2026 planning scenario; these dates must not be silently rolled forward because the demo occurs on 20 September.
6. Save sanitized timing evidence and screenshots after each stage. Iterate: reproduce failure → add a regression assertion → fix the cause → rerun the entire sequence.

### Real audio and live-provider path — also required

Run both presenters’ audio through actual capture/transcription and the production assistant/tool path, with two clients and visible video. Recorded speech through the real capture path can automate repeatability; also rehearse with the two humans and the intended mute/headset arrangement. Confirm both speakers are heard and the same shared conversation drives the canvas.

Do not count injected transcripts, mocked provider replies, direct `window.__kan.tools` calls, or a local-only canvas as proof of this path. Existing tests are useful building blocks, not substitutes for the missing two-person voice test.

### Repository verification starting points

Use Node **24+** and the current branch’s documented environment. From the repo root:

```sh
npm run typecheck
npm run test
npm run build
```

For native app verification, read the e2e skill first, then launch an isolated instance:

```sh
npm run tauri:drive
node scripts/drive.mjs snapshot
node scripts/drive.mjs shot /tmp/kan-demo-check.png
```

Start the app in the background, wait for driver readiness on the configured port, and read startup logs before driving it. Defaults are Vite **1420** and WebDriver **4445**. Never stop or drive someone else’s app; use the documented separate-instance identifiers, ports, and data directories. Drive each instance serially; do not run multiple scripts against the same window concurrently.

Relevant existing checks include `scripts/canvas-tools.e2e.mjs`, `scripts/date-nodes.e2e.mjs`, and `scripts/local-agent.e2e.mjs`. Inspect their setup and coverage before using them; the local-agent check needs a signed-in provider and does not establish live multi-user audio behavior.

If the cloud environment cannot run the presenters’ native Tauri/WKWebView setup, complete all feasible backend/integration/browser checks there and **mark native verification blocked**. Arrange the final two-client native rehearsal on the presenters’ machines. A browser pass is not evidence of native IPC, microphone routing, or window behavior working.

## 6. Morning handoff and go/no-go

Deliver the implementation, reusable test, tested CSV, and a concise report containing:

- Exact revision and startup/preflight instructions, including services and required environment-variable names, never values.
- Pass/fail by demo step, both-client screenshots, and measured latencies from the three complete rehearsals.
- What used real audio/providers versus fixtures/mocks, which platform ran, and every skipped or blocked check.
- Confirmed venue names/locations, capacity provenance or explicit unknowns, verified holiday note, and sponsor asset readiness.
- The chosen discard appearance and the precise, tested mute/headset setup.
- Remaining risks and one honest recovery action per likely failure. A manual fallback must be disclosed as manual, not presented as autonomous behavior.

**Ready means:** all three stages succeed repeatedly, both people drive the same AI conversation, the shared canvas stays consistent, connected notes are useful, discard is obvious, and every required visible response meets the two-second target. If any part is unverified or over budget, say so plainly and identify the next action. Do not declare success based on compilation alone.
