import type { ReconciledOption } from "../../shared/engine-options.ts";
import type { OptionValue } from "../../shared/option-catalogue.ts";

/**
 * Options the engine reads as a request when they arrive, even at their default. Sending the
 * default of `split` sets the engine's `split_is_set`, `sm-cluster` would get the word "None" as an
 * address, and an empty `rerun-from`, `cameras` or `boundary` is not what leaving them out means.
 * A run sends these only when its value differs from the engine's default (ADR 0012). The process
 * count and GPU use join them, so the engine keeps its own count and its GPU unless told otherwise.
 */
const SENT_WHEN_CHANGED: ReadonlySet<string> = new Set([
  "max-concurrency", "no-gpu", "cameras", "boundary", "use-exif", "force-gps",
  "split", "split-overlap", "sm-cluster", "sm-no-align", "merge", "end-with", "rerun-from",
]);

/** What the server knows about the engine a run goes to. GPU use is null when unknown. */
export type RunEngine = { kind: "local" | "remote"; gpu: boolean | null };

/**
 * The value the server gives an option when the operator leaves it alone, where that differs from
 * what the engine would do: map tiles always, and no GPU on a local engine that has none.
 */
function serverValue(option: ReconciledOption, engine: RunEngine): OptionValue | undefined {
  if (option.locked === "always-on") return true;
  if (option.name === "tiles") return true;
  if (option.name === "no-gpu" && engine.kind === "local") return engine.gpu !== true;
  return undefined;
}

/**
 * The editor's rows with the server's values as their defaults (ADR 0012), so that leaving a row
 * at its default is what lets the server set it, and an edited row keeps the operator's value.
 */
export function withServerDefaults(rows: readonly ReconciledOption[], engine: RunEngine): ReconciledOption[] {
  return rows.map((row) => {
    const value = serverValue(row, engine);
    return value === undefined || value === row.defaultValue ? row : { ...row, defaultValue: value };
  });
}

/**
 * What a run sends, from the value of every row: a locked option is always on, an option of
 * SENT_WHEN_CHANGED goes only when it departs from the engine's own default, every other one goes.
 */
export function sentOptions(values: readonly { name: string; value: OptionValue }[], rows: readonly ReconciledOption[], engineRows: readonly ReconciledOption[]): Array<{ name: string; value: OptionValue }> {
  const locked = new Set(rows.filter((row) => row.locked !== null).map((row) => row.name));
  const engineDefaults = new Map(engineRows.map((row) => [row.name, row.defaultValue]));
  return values.flatMap(({ name, value }) => {
    if (locked.has(name)) return [{ name, value: true }];
    if (SENT_WHEN_CHANGED.has(name) && value === engineDefaults.get(name)) return [];
    return [{ name, value }];
  });
}

/**
 * The options left at a default the server chose, where the engine on its own would do otherwise.
 * Review lists them with the value the run sends. Locked options are not here: Review names them apart.
 */
export function serverChosen(values: readonly { name: string; value: OptionValue }[], rows: readonly ReconciledOption[], engineRows: readonly ReconciledOption[]): Array<{ name: string; value: OptionValue; defaultValue: OptionValue }> {
  const engineDefaults = new Map(engineRows.map((row) => [row.name, row.defaultValue]));
  const current = new Map(values.map(({ name, value }) => [name, value]));
  return rows.flatMap((row) => {
    const engineDefault = engineDefaults.get(row.name);
    if (row.locked !== null || engineDefault === undefined || row.defaultValue === engineDefault || current.get(row.name) !== row.defaultValue) return [];
    return [{ name: row.name, value: row.defaultValue, defaultValue: engineDefault }];
  });
}
