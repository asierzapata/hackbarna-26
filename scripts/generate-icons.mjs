import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const icons = join(root, "apps/desktop/src-tauri/icons");
const output = await mkdtemp(join(tmpdir(), "kan-icons-"));
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });

try {
  run("xcrun", [
    "actool", join(icons, "Kan.icon"), "--compile", output,
    "--output-format", "human-readable-text", "--notices", "--warnings",
    "--output-partial-info-plist", join(output, "Info.plist"),
    "--app-icon", "Kan", "--include-all-app-icons",
    "--enable-on-demand-resources", "NO", "--target-device", "mac",
    "--minimum-deployment-target", "26.0", "--platform", "macosx",
  ]);
  const generated = join(output, "generated");
  run(process.execPath, [
    join(root, "node_modules/@tauri-apps/cli/tauri.js"),
    "icon", join(icons, "source.png"), "--output", generated,
  ]);
  for (const entry of await readdir(generated, { withFileTypes: true })) {
    if (entry.isFile() && /\.(png|ico)$/.test(entry.name)) {
      await copyFile(join(generated, entry.name), join(icons, entry.name));
    }
  }
  await copyFile(join(output, "Kan.icns"), join(icons, "icon.icns"));
  await copyFile(join(output, "Assets.car"), join(icons, "Assets.car"));
} finally {
  await rm(output, { recursive: true, force: true });
}
