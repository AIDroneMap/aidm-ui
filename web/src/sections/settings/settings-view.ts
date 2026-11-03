import type { EngineOption, ReconciledOption } from "../../../../shared/engine-options.ts";
import type { OptionValue } from "../../../../shared/option-catalogue.ts";
import type { resolveSettings, SettingsDraft } from "../../../../shared/run-settings.ts";

export type Resolved = ReturnType<typeof resolveSettings>;
export type RowGroup = ReconciledOption["group"];

/** The five texts the catalogue keeps for every option it explains. */
export const OPTION_TEXTS = ["name", "description", "when", "cost", "example"] as const;

/**
 * The words search looks in: the engine's flag, then the plain name and the
 * four other texts, or the engine's help for an option the catalogue does not
 * explain yet.
 */
export function searchTexts(option: ReconciledOption, text: (key: string) => string): string[] {
  if (option.unexplained) return [option.name, option.help ?? ""];
  return [option.name, ...OPTION_TEXTS.map((field) => text(`option.${option.name}.${field}`))];
}

export function matchesSearch(option: ReconciledOption, query: string, text: (key: string) => string): boolean {
  const wanted = query.trim().toLocaleLowerCase();
  return !wanted || searchTexts(option, text).some((words) => words.toLocaleLowerCase().includes(wanted));
}

/** What a row's control holds: the operator's text while it is edited, otherwise the value the run would use. */
export function shownValue(option: ReconciledOption, draft: SettingsDraft, resolved: Resolved): OptionValue | undefined {
  return Object.hasOwn(draft, option.name) ? draft[option.name] : resolved.values[option.name] ?? resolved.baseline[option.name];
}

/**
 * True when this run's value differs from the engine's default, or is a
 * value the engine does not accept. A locked option is never changed: the
 * task API decides its value.
 */
export function changedFromDefault(option: ReconciledOption, resolved: Resolved): boolean {
  if (option.locked !== null) return false;
  if (resolved.errors[option.name]) return true;
  return Object.hasOwn(resolved.values, option.name) && resolved.values[option.name] !== option.defaultValue;
}

/** True when the operator changed this option away from the preset the run started from. */
export function changedFromPreset(option: ReconciledOption, draft: SettingsDraft, resolved: Resolved): boolean {
  if (!Object.hasOwn(draft, option.name)) return false;
  return Boolean(resolved.errors[option.name]) || resolved.values[option.name] !== resolved.baseline[option.name];
}

/** How many options of each group differ from the engine's defaults. */
export function changedCounts(options: readonly ReconciledOption[], resolved: Resolved): Map<RowGroup, number> {
  const counts = new Map<RowGroup, number>();
  for (const option of options) if (changedFromDefault(option, resolved)) counts.set(option.group, (counts.get(option.group) ?? 0) + 1);
  return counts;
}

export type CompareMode = "defaults" | "preset";

export type CompareRow = {
  name: string;
  /** The value compared to: the engine's default, or the preset's value. */
  reference: OptionValue;
  /** This run's value, or the operator's text when the engine would not accept it. */
  value: OptionValue;
};

/** Every option that differs from the reference, in the order of the groups. */
export function compareRows(mode: CompareMode, options: readonly ReconciledOption[], draft: SettingsDraft, resolved: Resolved): CompareRow[] {
  return options.flatMap((option) => {
    const differs = mode === "defaults" ? changedFromDefault(option, resolved) : changedFromPreset(option, draft, resolved);
    if (!differs) return [];
    const reference = mode === "defaults" ? option.defaultValue : resolved.baseline[option.name]!;
    const value = resolved.errors[option.name] ? draft[option.name]! : resolved.values[option.name]!;
    return [{ name: option.name, reference, value }];
  });
}

/**
 * The draft after one row goes back to the reference. Back to the preset
 * drops the edit. Back to the engine's default drops it too when the preset
 * already uses the default, and otherwise sets the default.
 */
export function resetRow(mode: CompareMode, option: ReconciledOption, draft: SettingsDraft, resolved: Resolved): SettingsDraft {
  const next: SettingsDraft = { ...draft };
  delete next[option.name];
  if (mode === "defaults" && resolved.baseline[option.name] !== option.defaultValue) next[option.name] = option.defaultValue;
  return next;
}

/** The options whose value the engine would not accept, which keep the run from going to review. */
export function invalidOptions(options: readonly ReconciledOption[], resolved: Resolved): ReconciledOption[] {
  return options.filter((option) => Boolean(resolved.errors[option.name]));
}

export type RangeText = { key: string; data: Record<string, string | number> };

/**
 * The allowed values of an option, read from the domain the engine reports,
 * as a translation key and its data. Null when the domain says nothing an
 * operator needs, such as free text or an on and off switch.
 */
export function optionRange(domain: EngineOption["domain"]): RangeText | null {
  if (Array.isArray(domain)) return { key: "settings.range.choices", data: { choices: domain.map(String).join(", ") } };
  if (domain === "json") return { key: "settings.range.json", data: {} };
  if (domain === "percent") return { key: "settings.range.percent", data: {} };
  const kind = (name: string) => (name === "integer" ? "whole" : "number");
  const plain = /^(positive |negative )?(integer|float)$/.exec(domain);
  if (plain) {
    if (!plain[1]) return { key: `settings.range.${kind(plain[2]!)}`, data: {} };
    return plain[1] === "positive " ? { key: `settings.range.${kind(plain[2]!)}_from`, data: { min: 0 } } : { key: `settings.range.${kind(plain[2]!)}_up_to`, data: { max: 0 } };
  }
  const between = /^(float|integer): ([-+.\d]+) <= x <= ([-+.\d]+)$/.exec(domain);
  if (between) return { key: `settings.range.${kind(between[1]!)}_between`, data: { min: Number(between[2]), max: Number(between[3]) } };
  const comparison = /^(float|integer) (>=|>|<|<=) ([-+.\d]+)$/.exec(domain);
  if (comparison) {
    const bound = Number(comparison[3]);
    const which = { ">=": "from", ">": "above", "<=": "up_to", "<": "below" }[comparison[2] as ">=" | ">" | "<=" | "<"];
    return { key: `settings.range.${kind(comparison[1]!)}_${which}`, data: which === "from" || which === "above" ? { min: bound } : { max: bound } };
  }
  return null;
}

/**
 * The engine's help as the engine prints it: the help it reports keeps the
 * placeholders its argument parser fills, so they are filled the same way,
 * with the default and the choices the engine reports.
 */
export function engineWords(option: ReconciledOption): string {
  const choices = Array.isArray(option.domain) ? option.domain.map(String).join(", ") : "";
  return option.help.replace(/%\((default|choices)\)s|%%/g, (whole, name?: string) => name === "default" ? String(option.defaultValue) : name === "choices" ? choices : "%");
}
