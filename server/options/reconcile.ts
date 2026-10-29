import type { EngineOption, ReconciledOption } from "../../shared/engine-options.ts";
import { OPTION_CATALOGUE, type OptionValue } from "../../shared/option-catalogue.ts";

function defaultValue(option: EngineOption): OptionValue {
  if (option.type === "bool") return option.value === "true";
  if (option.type === "int" || option.type === "float") return Number(option.value);
  return option.value;
}

function sameDomain(left: string | readonly string[], right: EngineOption["domain"]): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return left.length === right.length && left.every((choice, index) => choice === right[index]);
}

/** Catalogue order first, then unknown engine options. Hidden names never reappear. */
export function reconcileOptions(engine: readonly EngineOption[]): ReconciledOption[] {
  const reported = new Map(engine.map((option) => [option.name, option]));
  const known = new Set(OPTION_CATALOGUE.map((option) => option.name));
  const result: ReconciledOption[] = [];
  for (const catalogue of OPTION_CATALOGUE) {
    const option = reported.get(catalogue.name);
    if (catalogue.bin !== "shown" || option === undefined) continue;
    const value = defaultValue(option);
    const changes: ReconciledOption["changes"] = [];
    if (option.type !== catalogue.type) changes.push("type");
    if (!sameDomain(catalogue.domain, option.domain)) changes.push("domain");
    if (value !== catalogue.defaultValue) changes.push("defaultValue");
    result.push({ ...catalogue, type: option.type, domain: option.domain, defaultValue: value, changes, unexplained: false });
  }
  for (const option of engine) {
    if (known.has(option.name)) continue;
    result.push({
      name: option.name, bin: "shown", group: "unexplained", type: option.type, domain: option.domain,
      defaultValue: defaultValue(option), presets: {}, dependencies: [], costTag: null,
      unexplained: true, changes: [], help: option.help,
    });
  }
  return result;
}
