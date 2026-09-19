import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createDiagnosticBuffer, failure, sanitizeDiagnostic, type DiagnosticEvent } from "@kan/protocol";
import { redactQaContext } from "./qa-context";

const buffer = createDiagnosticBuffer();
const subscribers = new Set<() => void>();
const writes = new Set<Promise<unknown>>();
let started: Promise<unknown> | undefined;
let persistenceError = false;
let captureUntil = 0;
const details: { at: number; turnId: string; error: string; stack?: string }[] = [];
const notify = () => subscribers.forEach((subscriber) => subscriber());
export const subscribeDiagnostics = (subscriber: () => void) => { subscribers.add(subscriber); return () => { subscribers.delete(subscriber); }; };
export const getDiagnostics = (turnId?: string) => ({ events: buffer.snapshot(turnId), persistenceError });
export function recordDiagnostic(input: Omit<DiagnosticEvent, "id" | "at" | "source">) {
  const event = sanitizeDiagnostic({ ...input, id: crypto.randomUUID(), at: Date.now(), source: "frontend" });
  buffer.add(event); notify();
  if (isTauri()) {
    const task = invoke("agent_diagnostic_record", { event }).catch(() => {
      if (!persistenceError) {
        persistenceError = true;
        buffer.add({ id: crypto.randomUUID(), at: Date.now(), source: "frontend", event: "diagnostic.persistence_failed", failure: failure("DIAGNOSTICS_UNAVAILABLE", "diagnostics", "not_applied") });
        notify();
      }
    }).finally(() => writes.delete(task));
    writes.add(task);
  }
}
export function startDiagnostics() {
  if (!isTauri()) return Promise.resolve();
  return started ??= listen<DiagnosticEvent>("agent:diagnostic", ({ payload }) => { buffer.add(payload); notify(); }).then(() => refreshDiagnostics()).catch(() => { persistenceError = true; notify(); });
}
export async function refreshDiagnostics(turnId?: string) {
  await Promise.all([...writes]);
  if (isTauri()) {
    const remote = await invoke<{ events: DiagnosticEvent[]; persistenceError: boolean }>("agent_diagnostics", { turnId });
    remote.events.forEach((event) => buffer.add(event));
    persistenceError = remote.persistenceError;
    notify();
  }
  return getDiagnostics(turnId);
}
export function captureFailureDetails(turnId: string, error: unknown) {
  if (Date.now() >= captureUntil) return;
  details.push(redactQaContext({ at: Date.now(), turnId, error: String(error).slice(0, 2000), stack: error instanceof Error ? error.stack?.slice(0, 4000) : undefined }));
  if (details.length > 32) details.shift();
}
export async function setDiagnosticCapture(enabled: boolean) {
  const response = await invoke<{ captureUntil: number }>("agent_diagnostics_capture", { enabled });
  captureUntil = response.captureUntil;
  if (!enabled) details.length = 0;
  return captureUntil;
}
export async function diagnosticDetails() {
  const native = await invoke<Record<string, unknown>>("agent_diagnostics_details");
  return redactQaContext({ frontend: details, native });
}
