import type { EngineOption } from "../../shared/engine-options.ts";
import { validateOptionValue } from "../../shared/option-validation.ts";
import type { TaskOption } from "../task-api/task-client.ts";

export interface InvalidOptions {
  kind: "invalid_options";
  name: string;
  reason: "unavailable" | "duplicate" | "type" | "domain";
}

/** Returns the first invalid value without creating a task. */
export function validateOptions(values: readonly TaskOption[], options: readonly EngineOption[]): InvalidOptions | null {
  const byName = new Map(options.map((option) => [option.name, option]));
  const seen = new Set<string>();
  for (const value of values) {
    const option = byName.get(value.name);
    if (option === undefined) return { kind: "invalid_options", name: value.name, reason: "unavailable" };
    if (seen.has(value.name)) return { kind: "invalid_options", name: value.name, reason: "duplicate" };
    seen.add(value.name);
    const reason = validateOptionValue(option.type, option.domain, value.value);
    if (reason !== null) return { kind: "invalid_options", name: value.name, reason };
  }
  return null;
}
