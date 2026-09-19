import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { api, createRoom, registerUser, ticket, EventsClient, sleep } from "./helpers";

const require = createRequire(import.meta.url);
async function unusedPort() {
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve())); return port;
}
async function launch(dir: string) {
  const port = await unusedPort();
  const child = spawn(process.execPath, ["--import", require.resolve("tsx"), fileURLToPath(new URL("../src/main.ts", import.meta.url))], { env: { PATH: process.env.PATH, HOME: process.env.HOME, KAN_CLASSIFIER: "disabled", KAN_DATA_DIR: dir, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; child.stdout.on("data", (chunk) => { output += String(chunk); }); child.stderr.on("data", (chunk) => { errors += String(chunk); });
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const deadline = Date.now() + 5000;
  while (!output.includes(`room-server listening on :${port}`)) {
    if (Date.now() > deadline || child.exitCode !== null) { child.kill("SIGKILL"); throw new Error(`main startup failed: ${errors}`); }
    await sleep(20);
  }
  return { port, base: `http://127.0.0.1:${port}`, stop: async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("main shutdown timed out")); }, 5000); })]).finally(() => clearTimeout(timer));
    assert.equal(code, 0); assert.doesNotMatch(errors, /internal_error|classification_persistence_error|TypeError/);
  } };
}

test("actual server main process: startup health two-user rooms messages events graceful shutdown and restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kan-main-test-"));
  const first = await launch(dir); t.after(async () => { await first.stop(); rmSync(dir, { recursive: true, force: true }); });
  const health = await (await fetch(`${first.base}/health`)).json(); assert.deepEqual(health, { ok: true, classifier: "disabled", video: false });
  const owner = await registerUser(first.base, "Owner"), member = await registerUser(first.base, "Member");
  const room = await createRoom(owner, first.base);
  assert.equal((await api(member, first.base, "/rooms/join", { method: "POST", body: JSON.stringify({ code: room.code }) })).status, 200);
  const observer = new EventsClient(first.port, room.id, await ticket(owner, first.base, room.id, "events")); await observer.ready;
  const message = await api(member, first.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: randomUUID(), text: "live-main-message" }) }); assert.equal(message.status, 200);
  await observer.waitFor((event) => event.type === "event" && event.event.entry.text === "live-main-message");
  observer.close(); await first.stop();
  const second = await launch(dir); t.after(() => second.stop());
  assert.equal((await api(owner, second.base, `/rooms/${room.id}/thread`)).body.entries[0].text, "live-main-message");
  const replay = new EventsClient(second.port, room.id, await ticket(member, second.base, room.id, "events")); await replay.ready;
  assert.ok(replay.messages.some((event) => event.type === "event" && event.event.entry.text === "live-main-message"));
  replay.close(); await second.stop();
});
