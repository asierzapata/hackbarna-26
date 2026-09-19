import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setup, registerUser, createRoom, sleep } from "../../room-server/test/helpers";

const require = createRequire(import.meta.url);
for (const oversized of [false, true]) test(`actual runner CLI ${oversized ? "rejects oversized stdin" : "closes cleanly from bounded JSON command"}`, async (t) => {
  const ctx = await setup({ classifier: null }); t.after(() => ctx.cleanup());
  const user = await registerUser(ctx.base), room = await createRoom(user, ctx.base);
  const child = spawn(process.execPath, ["--import", require.resolve("tsx"), fileURLToPath(new URL("../src/main.ts", import.meta.url))], { env: { PATH: process.env.PATH, HOME: process.env.HOME, KAN_SERVER_URL: ctx.base, KAN_ROOM_ID: room.id, KAN_USER_ID: user.id, KAN_USER_SECRET: user.secret, KAN_AGENT_COMMAND: "/not-used-without-manual-intent" }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let stdout = "", stderr = ""; child.stdout.on("data", (data) => { stdout += String(data); }); child.stderr.on("data", (data) => { stderr += String(data); });
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const deadline = Date.now() + 5000;
  while (!stdout.includes('"connected"')) { if (Date.now() > deadline) throw new Error("runner CLI startup timeout"); await sleep(20); }
  child.stdin.write(oversized ? "x".repeat(65537) : '{"type":"close"}\n');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("runner CLI shutdown timeout")), 5000); })]).finally(() => clearTimeout(timer));
  assert.equal(code, oversized ? 1 : 0);
  assert.ok(!stdout.includes(user.secret) && !stderr.includes(user.secret));
  for (const line of stdout.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
});
