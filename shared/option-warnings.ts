// Section 6.5 of docs/proposals/0001-desktop-class-interface.md. Each rule comes from the engine's own
// post-parse rules or help text: https://github.com/AIDroneMap/aidm/blob/68c643965349e7e0bb5e2a0595bcbeca645c70fe/modules/config.py
import type { OptionValue } from "./option-catalogue.ts";
import { RUN_STAGES } from "./run-stages.ts";

/** The code of each warning, which is also its key in the translation file. The quality rule has three. */
export const WARNING_CODES = [
  "warn.fast_orthophoto", "warn.mesh_makes_model", "warn.ground_classifies", "warn.cutline_crop", "warn.ignore_gsd",
  "warn.quality_point_cloud", "warn.quality_features", "warn.quality_both", "warn.hamming_cpu", "warn.planar",
  "warn.processes_over_cores", "warn.nothing_to_view", "warn.end_with", "warn.rerun_from", "warn.split",
  "warn.cluster", "warn.disk_space", "warn.resolution_capped", "warn.no_ground_control",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/** What a run that stops early does not make, in the order the stages make it. */
export const LOST_OUTPUTS = ["3d-model", "point-cloud", "elevation-models", "orthophoto", "report", "viewer-model"] as const;
export type LostOutput = (typeof LOST_OUTPUTS)[number];
const MADE_BY: Partial<Record<string, LostOutput>> = {
  mvs_texturing: "3d-model", odm_georeferencing: "point-cloud", odm_dem: "elevation-models",
  odm_orthophoto: "orthophoto", odm_report: "report", odm_postprocess: "viewer-model",
};

/** Lowest first, as the engine orders its quality choices from the other end. */
const QUALITY = ["lowest", "low", "medium", "high", "ultra"];

/** What the rules know besides the values: the engine the run goes to and the photos it takes. */
export type WarningContext = {
  /** Kind and GPU use are null when unknown. */
  engine: { kind: "local" | "remote" | null; gpu: boolean | null; cpuCores: number | null };
  /** Null when the photos are not counted before the run, as for a linked archive. */
  photoCount: number | null;
};

/** A notice shown under each of its rows. It never blocks the run. */
export type OptionWarning = {
  code: WarningCode;
  options: readonly string[];
  data?: { cores?: number; stage?: string; lost?: readonly LostOutput[] };
};

/**
 * The warnings for one set of option values. Only options the engine offers count; a rule
 * that needs a fact the context lacks stays silent.
 */
export function optionWarnings(options: readonly { name: string; defaultValue: OptionValue }[], values: Readonly<Record<string, OptionValue>>, context: WarningContext): OptionWarning[] {
  const defaults = new Map(options.map((option) => [option.name, option.defaultValue]));
  const value = (name: string): OptionValue | undefined => defaults.has(name) && Object.hasOwn(values, name) ? values[name] : undefined;
  const on = (name: string) => value(name) === true;
  const changed = (name: string) => value(name) !== undefined && value(name) !== defaults.get(name);
  const raised = (name: string) => { const base = QUALITY.indexOf(String(defaults.get(name))); return base >= 0 && QUALITY.indexOf(String(value(name))) > base; };
  const below = (name: string) => { const set = value(name), base = defaults.get(name); return typeof set === "number" && typeof base === "number" && set < base; };
  const warnings: OptionWarning[] = [];
  const warn = (code: WarningCode, rows: readonly string[], data?: OptionWarning["data"]) => { warnings.push(data ? { code, options: rows, data } : { code, options: rows }); };

  if (on("fast-orthophoto")) warn("warn.fast_orthophoto", ["fast-orthophoto"]);
  if (on("use-3dmesh") && on("skip-3dmodel")) warn("warn.mesh_makes_model", ["use-3dmesh", "skip-3dmodel"]);
  if (on("dtm") && value("pc-classify") !== true) warn("warn.ground_classifies", ["dtm"]);
  if (on("orthophoto-cutline") && value("crop") === 0) warn("warn.cutline_crop", ["orthophoto-cutline", "crop"]);
  if (on("ignore-gsd")) warn("warn.ignore_gsd", ["ignore-gsd"]);
  const quality = ["feature-quality", "pc-quality"].filter(raised);
  if (quality.length === 2) warn("warn.quality_both", quality);
  else if (quality[0] === "pc-quality") warn("warn.quality_point_cloud", quality);
  else if (quality[0] === "feature-quality") warn("warn.quality_features", quality);
  if (value("matcher-type") === "hamming" && context.engine.kind === "local" && context.engine.gpu === false) warn("warn.hamming_cpu", ["matcher-type"]);
  if (value("sfm-algorithm") === "planar") warn("warn.planar", ["sfm-algorithm"]);
  const processes = value("max-concurrency"), cores = context.engine.cpuCores;
  if (typeof processes === "number" && cores !== null && processes > cores) warn("warn.processes_over_cores", ["max-concurrency"], { cores });
  if (on("skip-orthophoto") && on("skip-3dmodel") && value("dsm") === false && value("dtm") === false) warn("warn.nothing_to_view", ["skip-orthophoto", "skip-3dmodel"]);
  const end = RUN_STAGES.indexOf(value("end-with") as never);
  const lost = end < 0 ? [] : RUN_STAGES.slice(end + 1).flatMap((stage) => MADE_BY[stage] ?? []);
  if (lost.length) warn("warn.end_with", ["end-with"], { stage: RUN_STAGES[end]!, lost });
  if (changed("rerun-from") && value("rerun-from") !== "") warn("warn.rerun_from", ["rerun-from"]);
  const split = value("split");
  if (typeof split === "number" && context.photoCount !== null && split < context.photoCount) warn("warn.split", ["split", "split-overlap"]);
  const cluster = value("sm-cluster");
  if (changed("sm-cluster") && typeof cluster === "string" && cluster.trim() !== "" && cluster !== "None") warn("warn.cluster", ["sm-cluster"]);
  if (on("optimize-disk-space")) warn("warn.disk_space", ["optimize-disk-space"]);
  // Without a measured ground sampling distance, a value finer than the engine default is the one the cap may reach.
  const capped = on("ignore-gsd") ? [] : [...(on("dsm") || on("dtm") ? ["dem-resolution"] : []), "orthophoto-resolution"].filter(below);
  if (capped.length) warn("warn.resolution_capped", capped);
  const gps = ["force-gps", "use-exif"].filter(on);
  if (gps.length) warn("warn.no_ground_control", gps);
  return warnings;
}
