export const CONTEXT_SETTLE_MS = 2_000;
// A busy room never goes quiet for CONTEXT_SETTLE_MS, so the settle timer alone
// starves the contextual check exactly when the conversation is most active.
// CONTEXT_MAX_WAIT_MS caps how long a pending cause can be deferred: the check
// runs on the first of "the room went quiet" or "this long has passed".
export const CONTEXT_MAX_WAIT_MS = 10_000;
export const CONTEXT_COOLDOWN_MS = 15_000;

// How pushy the contextual assistant is, as a named pair of the only two knobs
// that actually pace it: how long a pending cause can be deferred before it is
// checked anyway, and how long after a contextual trigger before the next one
// is allowed. Named presets rather than raw fields so the wire value stays
// meaningful and a room cannot be configured into a pathological rate.
export const ASSISTANT_EAGERNESS = ["relaxed", "balanced", "eager", "insistent"] as const;
export type AssistantEagerness = (typeof ASSISTANT_EAGERNESS)[number];
export const DEFAULT_EAGERNESS: AssistantEagerness = "eager";

export interface EagernessPacing {
  /** 0 disables the periodic sweep: the check then only runs after a silence. */
  maxWaitMs: number;
  cooldownMs: number;
  label: string;
  description: string;
}

export const EAGERNESS_PACING: Record<AssistantEagerness, EagernessPacing> = {
  relaxed: { maxWaitMs: 0, cooldownMs: 60_000, label: "Relaxed", description: "Only in a pause, at most once a minute" },
  balanced: { maxWaitMs: 10_000, cooldownMs: 30_000, label: "Balanced", description: "Every 10s of talk, at most once every 30s" },
  eager: { maxWaitMs: 10_000, cooldownMs: 15_000, label: "Eager", description: "Every 10s of talk, at most once every 15s" },
  insistent: { maxWaitMs: 4_000, cooldownMs: 5_000, label: "Insistent", description: "Every 4s of talk, at most once every 5s" },
};

export function eagernessPacing(value: string | null | undefined): EagernessPacing {
  return EAGERNESS_PACING[(value ?? DEFAULT_EAGERNESS) as AssistantEagerness] ?? EAGERNESS_PACING[DEFAULT_EAGERNESS];
}
export const CONTEXT_MAX_AGE_MS = 120_000;
export const AGENT_TURN_TIMEOUT_MS = 180_000;

export function explicitInvocation(text: string, source: "typed" | "transcript" = "typed") {
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0];
  if (/^@(?:kan|assistant)(?=$|[\s,!:?])/i.test(firstLine)) return true;
  return source === "transcript" && /^hey\s+kan(?=$|[\s,!:?.])/i.test(firstLine);
}

export { ASSISTANT_INSTRUCTIONS, buildAssistantPrompt } from "./prompts";
