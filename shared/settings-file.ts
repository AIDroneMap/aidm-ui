import type { ReconciledOption } from "./engine-options.ts";
import type { OptionValue } from "./option-catalogue.ts";
import { validateOptionValue } from "./option-validation.ts";

export const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;
export type SettingValue = { name: string; value: OptionValue };
export type SettingsFile = { options: SettingValue[]; preset: string; engineVersion: string | null };
export type SavedPreset = SettingsFile & { id: number };
export type DroppedSetting = SettingValue & { reason: "unavailable" | "type" | "domain" };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The interchange document has exactly the three parts an operator exports. */
export function parseSettingsFile(value: unknown): SettingsFile | null {
  if (!record(value) || Object.keys(value).length !== 3 || !["options", "preset", "engineVersion"].every(key => Object.hasOwn(value, key))) return null;
  if (typeof value.preset !== "string" || !value.preset.trim() || value.preset.length > 200) return null;
  if (value.engineVersion !== null && (typeof value.engineVersion !== "string" || !value.engineVersion.trim() || value.engineVersion.length > 200)) return null;
  if (!Array.isArray(value.options) || value.options.length > 256) return null;
  const names = new Set<string>();
  const options: SettingValue[] = [];
  for (const item of value.options) {
    if (!record(item) || Object.keys(item).length !== 2 || !Object.hasOwn(item, "name") || !Object.hasOwn(item, "value") || typeof item.name !== "string" || !item.name || item.name.length > 200 || names.has(item.name)) return null;
    if (!(typeof item.value === "boolean" || typeof item.value === "number" && Number.isFinite(item.value) || typeof item.value === "string" && item.value.length <= 65536)) return null;
    names.add(item.name); options.push({ name: item.name, value: item.value });
  }
  return { options, preset: value.preset.trim(), engineVersion: value.engineVersion };
}

/** Keep only values the selected engine exposes to the settings editor. */
export function reconcileSettingsFile(file: SettingsFile, options: readonly ReconciledOption[]): { values: SettingValue[]; dropped: DroppedSetting[] } {
  const byName = new Map(options.map(option => [option.name, option]));
  const values: SettingValue[] = [], dropped: DroppedSetting[] = [];
  for (const item of file.options) {
    const option = byName.get(item.name);
    const reason = option ? validateOptionValue(option.type, option.domain, item.value) : "unavailable";
    if (reason) dropped.push({ ...item, reason }); else values.push({ ...item });
  }
  return { values, dropped };
}
