import { buildEvaluationQuestions, CONTEXT_COOLDOWN_MS, CONTEXT_MAX_WAIT_MS, CONTEXT_SETTLE_MS, DEFAULT_ASSISTANT_THRESHOLD, explicitInvocation } from "@kan/protocol";

export interface Decision {
  triggerProbability: number;
}

export interface ClassificationState {
  cause: { id: string; kind: "message" | "system"; text: string; authorId: string };
  recentEntries: unknown[];
  shapes: { id: string; label: string; props?: unknown; type?: string }[];
  openSuggestions: unknown[];
  recentResolvedContributions?: unknown[];
}

export const CLASSIFIER_MODEL = "typesafe-ai/jev";
export const CLASSIFIER_POLICY_VERSION = "binary-context-v1";
export const TRIGGER_PROBABILITY_THRESHOLD = DEFAULT_ASSISTANT_THRESHOLD;
export const CLASSIFIER_TIMEOUT_MS = 8_000;
export const CLASSIFIER_MAX_RETRIES = 0;
export const HUMAN_EDIT_DEBOUNCE_MS = CONTEXT_SETTLE_MS;
export const PROACTIVE_COOLDOWN_MS = CONTEXT_COOLDOWN_MS;
export const PROACTIVE_MAX_WAIT_MS = CONTEXT_MAX_WAIT_MS;

export function evaluationQuestions() {
  return buildEvaluationQuestions();
}

export function explicitMention(text: string, source: "typed" | "transcript" = "typed") {
  return explicitInvocation(text, source);
}

export function triggerDecision(decision: Decision, threshold = TRIGGER_PROBABILITY_THRESHOLD, mode: "context" | "act" = "context") {
  const probability = decision.triggerProbability;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1 || !Number.isFinite(probability) || probability <= threshold || probability > 1) return null;
  return {
    mode,
    intent: "answer" as const,
    confidence: probability,
    reason: mode === "act"
      ? "The live conversation contains a grounded assistant action; fulfill the latest request using the supplied room context."
      : "The exchange warrants a contextual assistant check: answer, clarify, or propose a grounded draft. No canvas changes are authorized.",
  };
}

export const EXPLICIT_TRIGGER = {
  mode: "act" as const,
  intent: "answer" as const,
  confidence: 1,
  reason: "A participant explicitly invoked Kan or replied to its contribution; fulfill only that request using the quoted cause.",
};
