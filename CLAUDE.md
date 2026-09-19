@AGENTS.md

## Before you say it works

Compiling is not working. **Run the app and drive it** before calling any UI or
frontend change done — use the `e2e` skill (`.agents/skills/e2e/`), which has
the commands and the traps. Default to `npm run tauri:drive` +
`node scripts/drive.mjs`; the browser path cannot test Tauri APIs, IPC or window
behaviour.

If you skipped a check, say so instead of implying you ran it.
