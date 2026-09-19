import { appendFileSync, mkdirSync, renameSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeDiagnostic, type DiagnosticEvent } from "@kan/protocol";

const directory = process.env.KAN_DIAGNOSTICS_DIR ?? join(homedir(), ".local", "state", "kan", "diagnostics");
export function recordRunnerDiagnostic(input: Omit<DiagnosticEvent, "id" | "at" | "source">) {
  const event = sanitizeDiagnostic({ ...input, id: crypto.randomUUID(), at: Date.now(), source: "runner" });
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, process.env.KAN_RUN_RUN_ID ? "mcp.jsonl" : "runner.jsonl");
    let size = 0;
    try { size = statSync(path).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (size > 1024 * 1024) renameSync(path, path + ".previous");
    appendFileSync(path, JSON.stringify(event) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    process.stderr.write(JSON.stringify({ event: "diagnostic.persistence_failed", source: "runner", runId: event.runId }) + "\n");
  }
  return event;
}
