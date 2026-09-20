import {
  ASSISTANT_EAGERNESS,
  DEFAULT_EAGERNESS,
  EAGERNESS_PACING,
  type AssistantEagerness,
} from "@kan/protocol";

/**
 * How much Kan chimes in, as one ladder.
 *
 * The panel used to expose this as two controls sitting next to each other: a
 * three-way scope toggle (My requests / Help canvas / Manual) and a four-level
 * eagerness select. Twelve combinations, of which four mean anything, and the
 * two that contradicted each other (`manual` plus any eagerness) both stayed
 * lit. They are really one question with a "never" at the bottom, so this is
 * one list.
 *
 * `asked` is `scope: "manual"`: Kan still answers `@kan`, it just never
 * volunteers. There is no true off, and pretending otherwise would be a lie.
 *
 * Whose work the agent runs (`own` vs `room`) is a genuinely different axis, a
 * compute-donation setting that means nothing on an offline canvas, so it stays
 * a separate switch rather than getting folded in here.
 */
export type ChimeIn = "asked" | AssistantEagerness;

export type AssistantScope = "own" | "room" | "manual";

export const CHIME_IN: readonly ChimeIn[] = ["asked", ...ASSISTANT_EAGERNESS];

export interface ChimeInOption {
  value: ChimeIn;
  label: string;
  description: string;
}

export const CHIME_IN_OPTIONS: readonly ChimeInOption[] = CHIME_IN.map((value) =>
  value === "asked"
    ? {
        value,
        label: "Only when asked",
        description: "Never speaks up on its own",
      }
    : {
        value,
        label: EAGERNESS_PACING[value].label,
        description: EAGERNESS_PACING[value].description,
      },
);

export function chimeInOption(value: ChimeIn): ChimeInOption {
  return (
    CHIME_IN_OPTIONS.find((option) => option.value === value) ??
    CHIME_IN_OPTIONS[0]
  );
}

/**
 * Derive the ladder from the two stored fields.
 *
 * Deriving rather than migrating is deliberate: `kan-assistant:<roomId>` in
 * localStorage and the server's `assistantEagerness` both keep their existing
 * shape, so an older client and this one read each other's rooms fine.
 */
export function toChimeIn(
  scope: AssistantScope,
  eagerness: AssistantEagerness,
): ChimeIn {
  if (scope === "manual") return "asked";
  return ASSISTANT_EAGERNESS.includes(eagerness) ? eagerness : DEFAULT_EAGERNESS;
}

/**
 * Project a ladder choice back onto the stored fields.
 *
 * `previousScope` is the scope to restore when leaving `asked`: someone who was
 * lending their agent to the room, went quiet for a meeting and came back
 * should still be lending it.
 */
export function fromChimeIn(
  value: ChimeIn,
  previousScope: AssistantScope,
): { scope: AssistantScope; eagerness?: AssistantEagerness } {
  if (value === "asked") return { scope: "manual" };
  return {
    scope: previousScope === "manual" ? "own" : previousScope,
    eagerness: value,
  };
}
