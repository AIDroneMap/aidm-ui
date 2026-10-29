import type { EngineOption } from "../../shared/engine-options.ts";
import type { TaskOption } from "../task-api/task-client.ts";

export interface InvalidOptions {
  kind: "invalid_options";
  name: string;
  reason: "unavailable" | "duplicate" | "type" | "domain";
}

function typeAccepts(type: EngineOption["type"], value: unknown): value is string | boolean | number {
  switch (type) {
    case "bool": return typeof value === "boolean";
    case "int": return typeof value === "number" && Number.isSafeInteger(value);
    case "float": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "enum": return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
  }
}

/** The domain grammar documented and checked by the task API. Unknown grammar fails closed. */
function domainAccepts(domain: EngineOption["domain"], value: string | number | boolean): boolean {
  if (Array.isArray(domain)) return domain.includes(value);
  if (domain === "") return true;
  if (domain === "string" || domain === "path") return typeof value === "string";
  if (domain === "json") {
    if (typeof value !== "string") return false;
    try { JSON.parse(value); return true; } catch { return false; }
  }
  if (typeof value !== "number") return false;
  if (domain === "percent") return value >= 0 && value <= 100;
  const numeric = /^(positive |negative )?(integer|float)$/.exec(domain);
  if (numeric) {
    if (numeric[2] === "integer" && !Number.isSafeInteger(value)) return false;
    return numeric[1] === "positive " ? value >= 0 : numeric[1] === "negative " ? value <= 0 : true;
  }
  const range = /^(float|integer): ([-+.\d]+) <= x <= ([-+.\d]+)$/.exec(domain);
  if (range) return (range[1] !== "integer" || Number.isSafeInteger(value)) && value >= Number(range[2]) && value <= Number(range[3]);
  const comparison = /^(float|integer) (>=|>|<|<=) ([-+.\d]+)$/.exec(domain);
  if (comparison) {
    if (comparison[1] === "integer" && !Number.isSafeInteger(value)) return false;
    const bound = Number(comparison[3]);
    switch (comparison[2]) {
      case ">=": return value >= bound;
      case ">": return value > bound;
      case "<=": return value <= bound;
      case "<": return value < bound;
    }
  }
  return false;
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
    if (!typeAccepts(option.type, value.value)) return { kind: "invalid_options", name: value.name, reason: "type" };
    if (!domainAccepts(option.domain, value.value)) return { kind: "invalid_options", name: value.name, reason: "domain" };
  }
  return null;
}
