import { conversationCases } from "./conversation-cases";
import { runConversation } from "../apps/room-server/test/conversation-harness";

const live = process.argv.includes("--live");
const modelIndex = process.argv.indexOf("--model");
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : undefined;
const caseIndex = process.argv.indexOf("--case");
const selected = caseIndex >= 0 ? process.argv[caseIndex + 1] : undefined;
const cases = conversationCases.filter(scenario => !selected || scenario.id === selected);
if (!cases.length) throw new Error("Unknown case; use colors or solar-system");
console.log(JSON.stringify({ mode: live ? "live" : "controlled", model: model ?? "provider default", targetMs: 3000 }));
for (const scenario of cases) {
  try {
    const report = await runConversation(scenario, {
      live, model, holdFirstResultMs: !live && scenario.id === "colors" ? 1100 : 0,
      onEvent: event => console.log(JSON.stringify({ case: scenario.id, ...event })),
    });
    console.log(JSON.stringify({ case: scenario.id, semanticPass: true, mode: report.mode, maxLagMs: report.maxLagMs, latencyTargetMet: report.latencyTargetMet }));
    if (process.argv.includes("--strict-latency") && !report.latencyTargetMet) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ case: scenario.id, semanticPass: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
