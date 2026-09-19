import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entry } from "@kan/protocol";
import { createLocalTransport } from "../src/lib/local-transport";

function setup() {
  let saved: Entry[] = [];
  const storage = {
    async read() { return structuredClone(saved); },
    async write(_id: string, entries: Entry[]) { saved = structuredClone(entries); },
  };
  const canvasId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const options = { canvasId, userId, storage, getCanvas: () => [], applyOperations: () => [] };
  return { storage, options, get saved() { return saved; } };
}

function replyInput(revision: string) {
  return { id: crypto.randomUUID(), revision, result: { kind: "reply" as const, text: "Answer", sources: [] } };
}

test("local explicit reply persists terminal state and reload does not replay", async () => {
  const fixture = setup();
  const transport = createLocalTransport(fixture.options);
  const entries = new Map<string, unknown>();
  const unsubscribe = transport.subscribe((entry) => entries.set(entry.id, entry));
  transport.setExecutorReady(true, "fixture", "own", false);
  await transport.send({ id: crypto.randomUUID(), text: "@kan answer", anchors: [], files: [], source: "typed" });
  const trigger = transport.snapshot().triggers[0];
  const lease = await transport.claimTrigger(trigger.id);
  const context = await transport.getLocalContext(lease!.runId);
  await transport.completeLocal(lease!.runId, replyInput(context.revision));
  assert.equal(fixture.saved.find((entry) => entry.kind === "trigger")?.trigger.status, "done");
  assert.equal(fixture.saved.find((entry) => entry.kind === "agent_turn")?.text, "Answer");
  unsubscribe();
  const reloaded = createLocalTransport(fixture.options);
  const ready = new Promise<void>((resolve) => reloaded.subscribe(() => {}, (snapshot) => { if (snapshot.ready) resolve(); }));
  await ready;
  assert.equal(fixture.saved.filter((entry) => entry.kind === "agent_turn").length, 1);
});

test("explicit silence is rejected and failed local runs are terminal", async () => {
  const fixture = setup();
  const transport = createLocalTransport(fixture.options);
  const unsubscribe = transport.subscribe(() => {});
  transport.setExecutorReady(true, "fixture", "own", false);
  await transport.send({ id: crypto.randomUUID(), text: "@kan answer", anchors: [], files: [], source: "typed" });
  const lease = await transport.claimTrigger(transport.snapshot().triggers[0].id);
  const context = await transport.getLocalContext(lease!.runId);
  await assert.rejects(() => transport.completeLocal(lease!.runId, { id: crypto.randomUUID(), revision: context.revision, result: { kind: "silent" } }), /Explicit requests/);
  await transport.failLocal(lease!.runId, "failed");
  assert.equal(fixture.saved.find((entry) => entry.kind === "trigger")?.trigger.status, "failed");
  unsubscribe();
});

test("one local run owns the canvas, cancellation rejects late completion, retry increments attempt", async () => {
  const fixture = setup();
  const transport = createLocalTransport(fixture.options);
  const unsubscribe = transport.subscribe(() => {});
  transport.setExecutorReady(true, "fixture", "own", false);
  await transport.send({ id: crypto.randomUUID(), text: "@kan first", anchors: [], files: [], source: "typed" });
  await transport.send({ id: crypto.randomUUID(), text: "@kan second", anchors: [], files: [], source: "typed" });
  const [first, second] = transport.snapshot().triggers;
  const lease = await transport.claimTrigger(first.id);
  await assert.rejects(() => transport.claimTrigger(second.id), /already working/);
  await transport.cancelTrigger(first.id);
  await assert.rejects(() => transport.completeLocal(lease!.runId, replyInput("local")), /no longer active/);
  await transport.retryTrigger(first.id);
  const retried = transport.snapshot().triggers.find((trigger) => trigger.id === first.id)!;
  const secondLease = await transport.claimTrigger(retried.id);
  assert.equal(secondLease!.attempt, 2);
  unsubscribe();
});
