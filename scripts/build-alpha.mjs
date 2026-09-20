import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.equal(process.platform, "darwin", "Build the macOS alpha on a Mac.");
assert.equal(process.arch, "arm64", "The site's current alpha download targets Apple Silicon.");
assert.ok(loadEnv("production", root, "VITE_").VITE_TLDRAW_LICENSE_KEY?.trim(), "Supply a valid VITE_TLDRAW_LICENSE_KEY before building the production canvas.");

const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
const config = {
  productName: "Kan Alpha",
  identifier: "com.asierzapata.kan.alpha",
  bundle: { macOS: { signingIdentity: "-" } },
};
run("npm", ["run", "tauri", "--", "build", "--bundles", "app,dmg", "--config", JSON.stringify(config)]);

const tauri = JSON.parse(await readFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const bundles = join(root, "apps/desktop/src-tauri/target/release/bundle");
const app = join(bundles, "macos/Kan Alpha.app");
const dmg = join(bundles, `dmg/Kan Alpha_${tauri.version}_aarch64.dmg`);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
run("hdiutil", ["verify", dmg]);

const publicDir = join(root, "apps/site/public");
await mkdir(publicDir, { recursive: true });
const staged = join(publicDir, "kan-alpha.dmg.next");
const download = join(publicDir, "kan-alpha.dmg");
await copyFile(dmg, staged);
await rename(staged, download);
const hash = createHash("sha256");
for await (const chunk of createReadStream(download)) hash.update(chunk);
console.log(JSON.stringify({ version: tauri.version, architecture: "arm64", bytes: (await stat(download)).size, sha256: hash.digest("hex"), download }, null, 2));
