import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { AssistantResultSchema, buildAssistantPrompt, directCanvasResult, type AssistantResult } from "@kan/protocol";
import { openAgentSession } from "../../agent-runner/src/acp-session";
import { parseStructuredOutput } from "../../desktop/src/lib/assistant-controller";
import { api, createRoom, registerUser, setup, ticket, EventsClient } from "./helpers";
import type { ConversationCase, ConversationTurn } from "../../../scripts/conversation-cases";

type Shape = { id: string; type: string; props: Record<string, any> };
export interface ConversationEvent {
  event: "input" | "action";
  atMs: number;
  turn: number;
  speaker: string;
  prompt?: string;
  expected?: ConversationTurn["expected"];
  startedAtMs?: number;
  lagMs?: number;
  execution?: "direct" | "controlled" | "live-model";
  nodes?: Array<{ id: string; label: string; color?: string }>;
  reply?: string;
}
function richText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const v = value as { text?: string; content?: unknown[] };
  return v.text ?? v.content?.map(richText).filter(Boolean).join(" ") ?? "";
}
const label = (shape: Shape) => shape.type === "geo" ? richText(shape.props.richText) : [shape.props.draft?.title, shape.props.draft?.label, shape.props.draft?.body].filter(Boolean).join(" ");

function controlledResult(index: number, shapes: Shape[]): AssistantResult {
  const node = (name: string) => shapes.find(shape => label(shape).startsWith(name))!;
  const graph = (labels: string[]) => ({ type: "diagram", nodes: labels.map((label, i) => ({ id: `n${i}`, label })), edges: [] });
  const operations = index === 0 ? [graph(["Sun: our star", "Mercury: closest planet to the Sun"])]
    : index === 1 ? [graph(["Venus: hottest planet", "Earth: our home planet"])]
    : index === 2 ? [{ type: "label", shapeId: node("Mercury").id, text: "Mercury: year lasts 88 Earth days" }]
    : index === 3 ? [graph(["Jupiter: largest planet, a gas giant"])]
    : [{ type: "label", shapeId: node("Earth").id, text: "Earth: about 71% of its surface is covered by water" }];
  return AssistantResultSchema.parse({ kind: "act", text: "Updated the learning diagram. What would you like to explore next?", sources: [], operations });
}

export async function runConversation(scenario: ConversationCase, options: { live?: boolean; model?: string; holdFirstResultMs?: number; onEvent?: (event: ConversationEvent) => void } = {}) {
  const ctx = await setup({ classifier: null });
  ctx.clock.t = Date.now();
  const observerClients: EventsClient[] = [];
  let presenceTimer: ReturnType<typeof setInterval> | undefined;
  const events: ConversationEvent[] = [];
  const emit = (event: ConversationEvent) => { events.push(event); options.onEvent?.(event); };
  try {
    const users = new Map<string, Awaited<ReturnType<typeof registerUser>>>();
    for (const speaker of new Set(scenario.turns.map(turn => turn.speaker))) users.set(speaker, await registerUser(ctx.base, speaker));
    const owner = [...users.values()][0];
    const room = await createRoom(owner, ctx.base);
    for (const user of [...users.values()].slice(1)) ctx.server.engine.joinRoom(user.id, room.code);
    const ev = new EventsClient(ctx.server.port(), room.id, await ticket(owner, ctx.base, room.id, "events"));
    observerClients.push(ev);
    await ev.ready;
    ctx.server.engine.setExecutorReady(room.id, ev.sessionId, true, "conversation-test", "room", false);
    const start = performance.now(), epoch = Date.now();
    const now = () => Math.round(performance.now() - start);
    const clock = () => { ctx.clock.t = epoch + now(); };
    clock();
    presenceTimer = setInterval(() => { clock(); ev.send({ type: "heartbeat" }); }, 5000);
    let queue = Promise.resolve();
    let failure: unknown;
    const knownIds = new Map<string, string>();
    const shapes = () => (ctx.server.engine.canvasRecords(room.id) as Shape[]).filter(shape => shape.type === "geo" || shape.type === "kan-node");
    const inputs = scenario.turns.map(async (turn, index) => {
      await pause(Math.max(0, turn.atMs - now()));
      clock();
      const user = users.get(turn.speaker)!;
      const messageId = randomUUID();
      const arrived = now();
      const response = await api(user, ctx.base, `/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ id: messageId, text: `@kan ${turn.prompt}` }) });
      assert.equal(response.status, 200);
      emit({ event: "input", atMs: arrived, turn: index, speaker: turn.speaker, prompt: turn.prompt, expected: turn.expected });
      queue = queue.then(async () => {
        if (failure) return;
        clock();
        const trigger = ctx.server.engine.listTriggers(room.id).find(trigger => trigger.causeEntryIds.includes(messageId))!;
        const lease = ctx.server.engine.claimTrigger(owner.id, room.id, trigger.id, { sessionId: ev.sessionId, manual: true });
        const auth = `Bearer ${lease.leaseToken}`;
        const context = ctx.server.engine.runContext(room.id, lease.runId, auth);
        const startedAtMs = now();
        let result = directCanvasResult("act", context);
        let execution: ConversationEvent["execution"] = "direct";
        if (!result) {
          if (options.live) {
            execution = "live-model";
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 90000);
            const heartbeat = setInterval(() => { clock(); ctx.server.engine.heartbeatRun(room.id, lease.runId, auth); }, 10000);
            let text = "";
            let agent: Awaited<ReturnType<typeof openAgentSession>> | undefined;
            try {
              agent = await openAgentSession({ command: process.env.DEVIN_BIN ?? "devin", args: ["acp", ...(options.model ? ["--model", options.model] : [])] }, { signal: controller.signal, onUpdate: ({ update }) => { if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") text += update.content.text; } });
              const response = await agent.prompt(buildAssistantPrompt("act", context));
              assert.equal(response.stopReason, "end_turn");
              result = parseStructuredOutput(text);
            } finally { clearTimeout(timer); clearInterval(heartbeat); await agent?.close(); }
          } else {
            execution = "controlled";
            result = controlledResult(index, shapes());
          }
        }
        if (index === 0 && options.holdFirstResultMs) await pause(options.holdFirstResultMs);
        clock();
        ctx.server.engine.completeRun(room.id, lease.runId, auth, { id: randomUUID(), revision: context.revision, result });
        const actual = shapes();
        emit({ event: "action", atMs: now(), turn: index, speaker: turn.speaker, startedAtMs, lagMs: now() - arrived, execution, nodes: actual.map(shape => ({ id: shape.id, label: label(shape), color: shape.props.color })), reply: result.kind === "silent" ? "" : result.text });
        assert.equal(actual.length, turn.expected.nodeCount, `${scenario.id} turn ${index}: unexpected node count`);
        if (turn.expected.color) {
          assert.equal(actual[0].props.color, turn.expected.color);
          const original = knownIds.get("box");
          if (original) assert.equal(actual[0].id, original, "Color changes must not replace the box");
          else knownIds.set("box", actual[0].id);
        }
        for (const name of turn.expected.labels ?? []) {
          const matches = actual.filter(shape => new RegExp(`^(?:The )?${name}\\b`, "i").test(label(shape)));
          assert.equal(matches.length, 1, `Expected one ${name} node`);
          if (knownIds.has(name)) assert.equal(matches[0].id, knownIds.get(name), `Existing ${name} was replaced`);
          else knownIds.set(name, matches[0].id);
        }
        if (turn.expected.edit) {
          const edit = turn.expected.edit;
          const shape = actual.find(shape => shape.id === knownIds.get(edit.node));
          assert.ok(shape, `Missing original ${edit.node}`);
          assert.ok(label(shape).includes(edit.contains), `Missing updated ${edit.node} fact: ${edit.contains}`);
        }
      }).catch(error => { failure ??= error; });
    });
    await Promise.all(inputs);
    await queue;
    if (failure) throw failure;
    const actions = events.filter(event => event.event === "action");
    return { id: scenario.id, mode: options.live ? "live (direct commands bypass model)" : "controlled (not model-quality evidence)", events, maxLagMs: Math.max(...actions.map(event => event.lagMs!)), latencyTargetMet: actions.every(event => event.lagMs! < 3000) };
  } finally {
    if (presenceTimer) clearInterval(presenceTimer);
    observerClients.forEach(client => client.close());
    await ctx.cleanup();
  }
}
