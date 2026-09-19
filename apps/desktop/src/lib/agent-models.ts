const families = ["Luna", "Terra", "Sol"] as const;

type Model = { id: string; label: string; disabled?: boolean };

export function selectableAgentModels<T extends Model>(models: T[], currentId?: string): T[] {
  return families.flatMap((family) => {
    const matches = models.filter((model) =>
      !/fusion/i.test(`${model.id} ${model.label}`) &&
      new RegExp(`\\b${family}\\b`, "i").test(`${model.id} ${model.label}`),
    );
    const model = matches.find((item) => item.id === currentId) ??
      matches.find((item) => !item.disabled && /\bhigh\b/i.test(`${item.id} ${item.label}`) && !/xhigh|x-high|fast|priority/i.test(`${item.id} ${item.label}`)) ??
      matches.find((item) => !item.disabled) ?? matches[0];
    return model ? [{ ...model, label: family }] : [];
  });
}
