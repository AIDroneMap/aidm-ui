import type { ReconciledOption } from "./engine-options.ts";
import { OPTION_CATALOGUE, type OptionValue, type PresetId } from "./option-catalogue.ts";

export type RunOutput = "orthophoto" | "dsm" | "dtm" | "3d-model" | "report" | "pc-las" | "pc-csv" | "pc-copc" | "3d-tiles" | "orthophoto-png" | "orthophoto-kmz";

export const SERVER_OUTPUT_KEYS = ["pc-ept", "cog", "gltf", "tiles"] as const;

export interface PresetPlan {
  preset: PresetId;
  presetOptions: Array<{ name: string; value: OptionValue }>;
  unsupportedPresetOptions: Array<{ name: string; value: OptionValue }>;
  effectiveOptions: Array<{ name: string; value: OptionValue }>;
  departures: Array<{ name: string; value: OptionValue; defaultValue: OptionValue }>;
  outputs: RunOutput[];
}

export function planPreset(preset: PresetId, options: readonly ReconciledOption[], edits: readonly { name: string; value: OptionValue }[] = []): PresetPlan {
  const supported = new Set(options.map((option) => option.name));
  const presetOptions = OPTION_CATALOGUE.flatMap((option) => {
    if (option.bin !== "shown") return [];
    const value = option.presets[preset];
    return value === undefined ? [] : [{ name: option.name, value }];
  });
  const unsupportedPresetOptions = presetOptions.filter((option) => !supported.has(option.name));
  const overrides = new Map(presetOptions.filter((option) => supported.has(option.name)).map(({ name, value }) => [name, value]));
  for (const edit of edits) if (supported.has(edit.name)) overrides.set(edit.name, edit.value);
  const effectiveOptions = options.map((option) => ({ name: option.name, value: overrides.get(option.name) ?? option.defaultValue }));
  const departures = options.flatMap((option) => {
    const value = overrides.get(option.name);
    return value === undefined || value === option.defaultValue ? [] : [{ name: option.name, value, defaultValue: option.defaultValue }];
  });
  const values = new Map(effectiveOptions.map(({ name, value }) => [name, value]));
  const outputs: RunOutput[] = [];
  if (values.get("skip-orthophoto") === false) outputs.push("orthophoto");
  if (values.get("dsm") === true) outputs.push("dsm");
  if (values.get("dtm") === true) outputs.push("dtm");
  if (values.get("fast-orthophoto") === false && values.get("skip-3dmodel") === false) outputs.push("3d-model");
  if (values.get("skip-report") === false) outputs.push("report");
  for (const name of ["pc-las", "pc-csv", "pc-copc"] as const) if (values.get(name) === true) outputs.push(name);
  if (values.get("3d-tiles") === true && values.get("fast-orthophoto") === false && values.get("skip-3dmodel") === false) outputs.push("3d-tiles");
  for (const name of ["orthophoto-png", "orthophoto-kmz"] as const) if (values.get(name) === true && values.get("skip-orthophoto") === false) outputs.push(name);
  return { preset, presetOptions, unsupportedPresetOptions, effectiveOptions, departures, outputs };
}
