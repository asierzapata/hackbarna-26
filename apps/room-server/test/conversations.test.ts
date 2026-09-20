import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationCases } from "../../../scripts/conversation-cases";
import { runConversation } from "./conversation-harness";

for (const scenario of conversationCases) test(`timestamped conversation: ${scenario.title}`, async () => {
  const report = await runConversation(scenario, { holdFirstResultMs: scenario.id === "colors" ? 1100 : 0 });
  const actions = report.events.filter(event => event.event === "action");
  assert.equal(actions.length, scenario.turns.length);
  assert.ok(report.latencyTargetMet, `Controlled execution exceeded 3s: ${report.maxLagMs}ms`);
  if (scenario.id === "colors") {
    const secondInput = report.events.find(event => event.event === "input" && event.turn === 1)!;
    assert.ok(secondInput.atMs < actions[0].atMs, "Second speaker must speak while creation is in flight");
    assert.equal(new Set(actions.map(event => event.nodes![0].id)).size, 1);
  } else {
    assert.ok(actions.at(-1)!.nodes!.some(node => node.label.startsWith("Mercury") && node.label.includes("88")));
    assert.ok(actions.at(-1)!.nodes!.some(node => node.label.startsWith("Earth") && node.label.includes("71")));
  }
});
