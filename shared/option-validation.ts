import type { EngineOption } from "./engine-options.ts";

export function validateOptionValue(type: EngineOption["type"], domain: EngineOption["domain"], value: unknown): "type" | "domain" | null {
  const typeValid = type === "bool" ? typeof value === "boolean"
    : type === "int" ? typeof value === "number" && Number.isSafeInteger(value)
    : type === "float" ? typeof value === "number" && Number.isFinite(value)
    : type === "string" ? typeof value === "string"
    : typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
  if (!typeValid) return "type";
  const typedValue = value as string | number | boolean;
  if (Array.isArray(domain)) return domain.includes(typedValue) ? null : "domain";
  if (domain === "") return null;
  if (domain === "string" || domain === "path") return typeof typedValue === "string" ? null : "domain";
  if (domain === "json") {
    if (typeof typedValue !== "string") return "domain";
    try { JSON.parse(typedValue); return null; } catch { return "domain"; }
  }
  if (typeof typedValue !== "number") return "domain";
  if (domain === "percent") return typedValue >= 0 && typedValue <= 100 ? null : "domain";
  const numeric = /^(positive |negative )?(integer|float)$/.exec(domain);
  if (numeric) {
    if (numeric[2] === "integer" && !Number.isSafeInteger(typedValue)) return "domain";
    return (numeric[1] === "positive " ? typedValue >= 0 : numeric[1] === "negative " ? typedValue <= 0 : true) ? null : "domain";
  }
  const range = /^(float|integer): ([-+.\d]+) <= x <= ([-+.\d]+)$/.exec(domain);
  if (range) return (range[1] !== "integer" || Number.isSafeInteger(typedValue)) && typedValue >= Number(range[2]) && typedValue <= Number(range[3]) ? null : "domain";
  const comparison = /^(float|integer) (>=|>|<|<=) ([-+.\d]+)$/.exec(domain);
  if (comparison) {
    if (comparison[1] === "integer" && !Number.isSafeInteger(typedValue)) return "domain";
    const bound = Number(comparison[3]);
    switch (comparison[2]) {
      case ">=": return typedValue >= bound ? null : "domain";
      case ">": return typedValue > bound ? null : "domain";
      case "<=": return typedValue <= bound ? null : "domain";
      case "<": return typedValue < bound ? null : "domain";
    }
  }
  return "domain";
}
