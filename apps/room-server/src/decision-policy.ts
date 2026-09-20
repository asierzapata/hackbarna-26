import { buildEvaluationQuestions, CONTEXT_COOLDOWN_MS, CONTEXT_MAX_WAIT_MS, CONTEXT_SETTLE_MS, explicitInvocation } from "@kan/protocol";

export type Intent = "answer" | "capture" | "update" | "lookup" | "evidence" | "align" | "none";

export interface Decision {
  addressedProbability: number;
  worthCapturingProbability: number;
  intent: Intent;
  intentProbability: number;
  relatedShapeId: string | null;
  needsExternalDataProbability: number;
  captureScore: number;
}

export interface ClassificationState {
  cause: { id: string; kind: "message" | "system"; text: string; authorId: string };
  recentEntries: unknown[];
  shapes: { id: string; label: string; props?: unknown; type?: string }[];
  openSuggestions: unknown[];
  recentResolvedContributions?: unknown[];
}

export const CLASSIFIER_MODEL = "typesafe-ai/jev";
export const CLASSIFIER_TIMEOUT_MS = 8_000;
export const CLASSIFIER_MAX_RETRIES = 0;
export const HUMAN_EDIT_DEBOUNCE_MS = CONTEXT_SETTLE_MS;
export const PROACTIVE_COOLDOWN_MS = CONTEXT_COOLDOWN_MS;
export const PROACTIVE_MAX_WAIT_MS = CONTEXT_MAX_WAIT_MS;

export function evaluationQuestions(state: ClassificationState) {
  return buildEvaluationQuestions(state.shapes);
}

export function explicitMention(text: string, source: "typed" | "transcript" = "typed") {
  return explicitInvocation(text, source);
}

export function triggerDecision(decision: Decision) {
  if (decision.intent === "none") return null;
  if (decision.addressedProbability > 0.8) {
    return { mode: "context" as const, intent: decision.intent, confidence: decision.addressedProbability, reason: `A possible assistant question warrants a grounded check (${decision.intent}); no canvas changes are authorized.` };
  }
  if (decision.worthCapturingProbability > 0.7 && decision.captureScore >= 2) {
    return { mode: "context" as const, intent: decision.intent, confidence: decision.worthCapturingProbability, reason: `The exchange may benefit from a grounded contribution (${decision.intent}); stay silent if it is no longer useful.` };
  }
  return null;
}

export const EXPLICIT_TRIGGER = {
  mode: "act" as const,
  intent: "answer" as const,
  confidence: 1,
  reason: "A participant explicitly invoked Kan or replied to its contribution; fulfill only that request using the quoted cause.",
};
