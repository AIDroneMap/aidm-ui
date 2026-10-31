import type { ReconciledOption } from "./engine-options.ts";
import type { OptionDependency, OptionValue, PresetId } from "./option-catalogue.ts";
import { validateOptionValue } from "./option-validation.ts";
import { planPreset } from "./run-plan.ts";

export type SettingsDraft = Record<string, OptionValue>;
export type SettingsFacts = { bands: boolean | null; videos: boolean | null };
export type MovedSetting = {
  name: string;
  before?: OptionValue;
  after?: OptionValue;
  changes: Array<"unavailable" | "type" | "domain" | "defaultValue" | "value">;
};

function parseValue(option: ReconciledOption, value: OptionValue): OptionValue {
  if ((option.type === "int" || option.type === "float") && typeof value === "string") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return value;
    return Number(value);
  }
  return value;
}

function meets(dependency: OptionDependency, values: Record<string, OptionValue>, facts: SettingsFacts): boolean {
  if (dependency.kind === "dataset") return facts[dependency.fact] === true;
  if (dependency.kind === "option") return Object.hasOwn(values, dependency.name) && values[dependency.name] === dependency.value;
  return dependency.alternatives.some((alternative) => meets(alternative, values, facts));
}

export function resolveSettings(options: readonly ReconciledOption[], preset: PresetId, draft: SettingsDraft, facts: SettingsFacts, baselineOptions: readonly { name: string; value: OptionValue }[] = []) {
  const baseline = Object.fromEntries(planPreset(preset, options, baselineOptions).effectiveOptions.map(({ name, value }) => [name, value])) as Record<string, OptionValue>;
  const values: Record<string, OptionValue> = Object.create(null);
  const errors: Record<string, "type" | "domain"> = Object.create(null);
  const disabled: Record<string, readonly OptionDependency[]> = Object.create(null);
  const overrides: Array<{ name: string; value: OptionValue }> = [];
  for (const option of options) {
    const hasDraft = Object.hasOwn(draft, option.name);
    const value = hasDraft ? parseValue(option, draft[option.name]!) : baseline[option.name]!;
    const error = validateOptionValue(option.type, option.domain, value);
    if (error !== null) errors[option.name] = error;
    else {
      values[option.name] = value;
      if (hasDraft && value !== baseline[option.name]) overrides.push({ name: option.name, value });
    }
  }
  for (const option of options) {
    const unmet = option.dependencies.filter((dependency) => !meets(dependency, values, facts));
    if (unmet.length) disabled[option.name] = unmet;
  }
  return { baseline, values, overrides, errors, disabled };
}

export function rebaseSettings(previous: readonly ReconciledOption[], next: readonly ReconciledOption[], preset: PresetId, draft: SettingsDraft, facts: SettingsFacts, baselines: { previous?: readonly { name: string; value: OptionValue }[]; next?: readonly { name: string; value: OptionValue }[] } = {}): { draft: SettingsDraft; moved: MovedSetting[] } {
  const oldValues = resolveSettings(previous, preset, draft, facts, baselines.previous).values;
  const nextByName = new Map(next.map((option) => [option.name, option]));
  const previousByName = new Map(previous.map((option) => [option.name, option]));
  const rebased: SettingsDraft = Object.create(null);
  for (const [name, value] of Object.entries(draft)) {
    const option = nextByName.get(name);
    if (option && validateOptionValue(option.type, option.domain, parseValue(option, value)) === null) rebased[name] = value;
  }
  const newValues = resolveSettings(next, preset, rebased, facts, baselines.next).values;
  const moved: MovedSetting[] = [];
  for (const name of new Set([...previousByName.keys(), ...nextByName.keys(), ...Object.keys(draft)])) {
    const beforeOption = previousByName.get(name);
    const afterOption = nextByName.get(name);
    const changes: MovedSetting["changes"] = [];
    if (!afterOption) changes.push("unavailable");
    if (beforeOption && afterOption) {
      if (beforeOption.type !== afterOption.type) changes.push("type");
      if (JSON.stringify(beforeOption.domain) !== JSON.stringify(afterOption.domain)) changes.push("domain");
      if (beforeOption.defaultValue !== afterOption.defaultValue) changes.push("defaultValue");
    }
    const before = oldValues[name];
    const after = newValues[name];
    if (before !== after) changes.push("value");
    if (changes.length) moved.push({ name, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }), changes });
  }
  return { draft: rebased, moved };
}
