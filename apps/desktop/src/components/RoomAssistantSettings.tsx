import * as React from "react";
import { AssistantSettingsSchema, CONTEXT_COOLDOWN_MS, DEFAULT_ASSISTANT_THRESHOLD, MAX_ASSISTANT_COOLDOWN_MS, type AssistantSettings } from "@kan/protocol";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "./ui/field";
import { Slider } from "./ui/slider";

export interface RoomAssistantSettingsProps {
  room?: Partial<AssistantSettings>;
  disabled?: boolean;
  onSave: (settings: Partial<AssistantSettings>) => Promise<Partial<AssistantSettings>>;
}

function readSettings(value: Partial<AssistantSettings> | undefined) {
  const parsed = AssistantSettingsSchema.safeParse({ assistantThreshold: value?.assistantThreshold, assistantCooldownMs: value?.assistantCooldownMs });
  return parsed.success ? parsed.data : null;
}

export function RoomAssistantSettings({ room, disabled = false, onSave }: RoomAssistantSettingsProps) {
  const id = React.useId();
  const threshold = room?.assistantThreshold ?? DEFAULT_ASSISTANT_THRESHOLD;
  const cooldownMs = room?.assistantCooldownMs ?? CONTEXT_COOLDOWN_MS;
  const supported = readSettings(room) !== null;
  const confirmed = React.useRef<AssistantSettings>({ assistantThreshold: threshold, assistantCooldownMs: cooldownMs });
  const pending = React.useRef(false);
  const [draft, setDraft] = React.useState(confirmed.current);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    confirmed.current = { assistantThreshold: threshold, assistantCooldownMs: cooldownMs };
    if (!pending.current) setDraft(confirmed.current);
  }, [threshold, cooldownMs]);

  async function commit(settings: Partial<AssistantSettings>) {
    if (disabled || !supported || pending.current) return;
    if (Object.entries(settings).every(([key, value]) => confirmed.current[key as keyof AssistantSettings] === value)) return;
    const before = confirmed.current;
    pending.current = true;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = readSettings(await onSave(settings));
      if (!result) throw new Error("The server did not confirm the settings. Update the room server and retry.");
      if (confirmed.current === before) confirmed.current = result;
      setDraft(confirmed.current);
      setSaved(true);
    } catch (cause) {
      setDraft(confirmed.current);
      setError(`Could not save assistant settings. Showing the last confirmed values. ${cause instanceof Error ? cause.message : "Please try again."}`);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  const unavailable = disabled || saving || !supported;
  const valueOf = (value: number | readonly number[]) => Array.isArray(value) ? value[0] : value as number;

  return (
    <FieldGroup className="gap-3" data-testid="room-assistant-settings" aria-busy={saving}>
      <Field data-disabled={unavailable} data-invalid={!!error}>
        <FieldLabel id={`${id}-threshold-label`} htmlFor={`${id}-threshold`} className="w-full">
          Probability threshold
          <output className="ms-auto" data-testid="assistant-threshold-value">{draft.assistantThreshold.toFixed(2)}</output>
        </FieldLabel>
        <Slider
          id={`${id}-threshold`}
          data-testid="assistant-threshold"
          aria-labelledby={`${id}-threshold-label`}
          aria-describedby={`${id}-threshold-description`}
          aria-invalid={!!error}
          value={[draft.assistantThreshold]}
          min={0}
          max={1}
          step={0.01}
          disabled={unavailable}
          onValueChange={(value) => setDraft((current) => ({ ...current, assistantThreshold: valueOf(value) }))}
          onValueCommitted={(value) => void commit({ assistantThreshold: valueOf(value) })}
        />
        <FieldDescription id={`${id}-threshold-description`}>Trigger when Jev's probability is above this value. Lower values allow more checks.</FieldDescription>
      </Field>
      <Field data-disabled={unavailable} data-invalid={!!error}>
        <FieldLabel id={`${id}-cooldown-label`} htmlFor={`${id}-cooldown`} className="w-full">
          Cooldown
          <output className="ms-auto" data-testid="assistant-cooldown-value">{draft.assistantCooldownMs / 1000}s</output>
        </FieldLabel>
        <Slider
          id={`${id}-cooldown`}
          data-testid="assistant-cooldown"
          aria-labelledby={`${id}-cooldown-label`}
          aria-describedby={`${id}-cooldown-description`}
          aria-invalid={!!error}
          value={[draft.assistantCooldownMs / 1000]}
          min={0}
          max={MAX_ASSISTANT_COOLDOWN_MS / 1000}
          step={1}
          disabled={unavailable}
          onValueChange={(value) => setDraft((current) => ({ ...current, assistantCooldownMs: valueOf(value) * 1000 }))}
          onValueCommitted={(value) => void commit({ assistantCooldownMs: valueOf(value) * 1000 })}
        />
        <FieldDescription id={`${id}-cooldown-description`}>Seconds between contextual triggers. Zero removes the cooldown; edits still require permission.</FieldDescription>
      </Field>
      <FieldDescription role="status" data-testid="assistant-settings-status">
        {!supported ? room ? "The room server needs an update before these controls can be used." : "Waiting for room settings…" : saving ? "Saving room settings…" : saved ? "Saved for everyone in this room." : "Shared room settings. Changes save when you release a slider."}
      </FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </FieldGroup>
  );
}
