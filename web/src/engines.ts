import { ENGINE_STATES, type EngineView } from "../../shared/api-types.ts";

const GIB = 1024 ** 3;

const countFormat = new Intl.NumberFormat("en");
const memoryFormat = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatCount(value: number): string {
  return countFormat.format(value);
}

/** The engine's own number of bytes shown in GiB with one decimal. Nothing is estimated. */
export function formatMemory(bytes: number): string {
  return memoryFormat.format(bytes / GIB);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEngineView(value: unknown): value is EngineView {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "number" &&
    (value["kind"] === "local" || value["kind"] === "remote") &&
    typeof value["name"] === "string" &&
    typeof value["address"] === "string" &&
    typeof value["enabled"] === "boolean" &&
    (ENGINE_STATES as readonly unknown[]).includes(value["state"]) &&
    (value["info"] === null || isRecord(value["info"])) &&
    (value["problem"] === null || isRecord(value["problem"])) &&
    (value["warning"] === null || isRecord(value["warning"]))
  );
}

/** Reads the data of one "engines" server-sent event. Returns null when it is not a list of engines. */
export function parseEngineList(data: string): EngineView[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(isEngineView)) return null;
  return parsed;
}
