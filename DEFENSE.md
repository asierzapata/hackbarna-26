# Production-readiness defense

## Verdict

The Norma review produced two actionable findings. Both were addressed in the
main branch, then checked again with a rescan. The remediation is recorded in
[commit `767dabd`](https://github.com/asierzapata/hackbarna-26/commit/767dabd76ed49ba588a0ce8e5d193040e570d6d3).

The final production-ready score is owned by the final Norma rescan; the score
itself is not duplicated in this repository. This file records the code change,
the reasoning behind it, and the findings we consciously kept after review.

## Scan → fix → rescan

1. **Scan:** Norma identified a swallowed runner-event error and missing
   cross-origin referrer protection. It also reported heuristic matches for
   loopback URLs and empty `catch` blocks.
2. **Fix:** The runner and desktop webview were hardened in
   [the remediation commit](https://github.com/asierzapata/hackbarna-26/commit/767dabd76ed49ba588a0ce8e5d193040e570d6d3).
3. **Rescan:** The two actionable findings were cleared. The remaining matches
   were reviewed against their execution paths and are documented below as
   intentional behavior or scanner false positives.

## Findings fixed

### 1. Runner errors are no longer silently discarded

`startRoomExecutor` publishes lifecycle events through `options.onEvent`. The
old implementation isolated listener failures with an empty `catch`, so an
`EPIPE` from the stdout consumer or a bug in an event listener could make the
runner lose observability while continuing without an explanation.

The fix keeps the isolation boundary—an embedder callback must not take down the
executor—but logs the event type and caught error. The runner remains available
to finish or reconnect, while operators get a diagnostic trail for the actual
failure.

- Implementation: [`apps/agent-runner/src/executor.ts`](apps/agent-runner/src/executor.ts#L57-L62)
- Evidence: [commit `767dabd`](https://github.com/asierzapata/hackbarna-26/commit/767dabd76ed49ba588a0ce8e5d193040e570d6d3)

### 2. Cross-origin requests no longer expose the full webview referrer

The desktop entry point now sets:

```html
<meta name="referrer" content="strict-origin-when-cross-origin" />
```

Same-origin navigation can retain its normal referrer behavior, while a
cross-origin request sends only the origin rather than the full path and query
string. This reduces accidental disclosure of route state or identifiers to an
external origin without changing the app's API behavior.

- Implementation: [`apps/desktop/index.html`](apps/desktop/index.html#L5-L6)
- Evidence: [commit `767dabd`](https://github.com/asierzapata/hackbarna-26/commit/767dabd76ed49ba588a0ce8e5d193040e570d6d3)

## Findings consciously accepted after review

### Malformed video identity metadata

`videoIdentity` parses metadata received from a remote video connection. Invalid
JSON or an object with the wrong shape falls back to the neutral display name
`Colleague`:

- Implementation: [`apps/desktop/src/lib/room-media.ts`](apps/desktop/src/lib/room-media.ts#L71-L80)

This is intentional defensive parsing, not an ignored application failure. The
input is remote-controlled metadata, and logging the raw parse failure would
create attacker-triggerable noise without improving the user-visible outcome.
The function validates the accepted shape, bounds the identifier and display
name, and returns a safe fallback. We therefore accepted this alert rather
than adding noisy logging or exposing connection metadata in diagnostics.

### Loopback URL matches

The reported loopback strings were reviewed individually and do not represent
an unintended production endpoint:

- The room server's `localhost` and Tauri origins are an explicit CORS allowlist,
  not an unrestricted network destination: [`apps/room-server/src/server.ts`](apps/room-server/src/server.ts#L25-L30).
- The `http://localhost` passed as the second argument to `new URL` is a parsing
  base for relative request paths; it does not create a network request:
  [`apps/room-server/src/server.ts`](apps/room-server/src/server.ts#L44-L50).
- The desktop backend has a deployed HTTPS default and an explicit
  `VITE_ROOM_SERVER_URL` override for local development:
  [`apps/desktop/src/lib/api-client.ts`](apps/desktop/src/lib/api-client.ts#L29-L38).
- The remaining loopback references belong to local WebDriver and HTTP test
  fixtures, where binding to loopback is the security boundary being tested.

These are useful matches for manual review, but changing them would either
break the native app's allowed-origin contract, remove a harmless parser
placeholder, or weaken local test isolation.

## Two-minute defense

> Norma found two issues worth fixing. First, our runner deliberately isolated
> callback failures, but the empty catch made an event-consumer failure silent.
> We kept the isolation so a bad consumer cannot crash the executor, and added a
> diagnostic containing the event type and error so the runner remains
> observable. Second, the desktop webview did not explicitly constrain the
> referrer sent cross-origin. We added `strict-origin-when-cross-origin`, which
> preserves normal same-origin behavior but prevents paths and query strings
> from being sent to other origins.
>
> We consciously accepted the malformed video-identity parse alert. That input
> comes from remote connection metadata, and the safe fallback is the intended
> behavior; logging arbitrary malformed input would add remote-triggerable noise
> without helping recovery. We also reviewed the loopback URL matches and found
> CORS allowlists, a URL parser base, an environment-overridable development
> default, and test fixtures—not hidden production endpoints. The result is a
> smaller and more honest alert set, with the actual reliability and privacy
> issues fixed and the residual matches explained rather than blindly changed.
