import { spawnSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

try { loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url))); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const key = process.env.GALTEA_API_KEY ?? process.env.GALTEA;
if (!key) throw new Error("Set GALTEA_API_KEY or GALTEA in .env.local");
if (process.argv.slice(2).some(arg => arg === "-v" || arg === "--verbose" || arg.startsWith("--verbose="))) throw new Error("HTTP debug output exposes credentials; verbose mode is disabled");
const child = spawnSync("uv", ["tool", "run", "--from", "galtea-cli==5.2.0", "galtea", ...process.argv.slice(2)], {
  env: { ...process.env, GALTEA_API_KEY: key, NO_COLOR: "1" },
  stdio: ["inherit", "pipe", "pipe"], encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
const redact = text => (text ?? "").replaceAll(key, "[REDACTED]").replace(/gsk_[A-Za-z0-9_-]+/g, "[REDACTED]");
process.stdout.write(redact(child.stdout));
process.stderr.write(redact(child.stderr));
if (child.error) throw new Error(child.error.message);
process.exitCode = child.status ?? 1;
