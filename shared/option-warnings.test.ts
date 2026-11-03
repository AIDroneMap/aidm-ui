import { expect, test } from "bun:test";
import recorded from "../test-support/fixtures/task-api-2.7.0-options.json";
import type { EngineOption } from "./engine-options.ts";
import { OPTION_CATALOGUE, type OptionValue } from "./option-catalogue.ts";
import { optionWarnings, WARNING_CODES, type OptionWarning, type WarningContext } from "./option-warnings.ts";
import { resolveSettings } from "./run-settings.ts";
import { reconcileOptions } from "../server/options/reconcile.ts";

const options = reconcileOptions(recorded as EngineOption[]);
const defaults: Record<string, OptionValue> = Object.fromEntries(options.map((option) => [option.name, option.defaultValue]));
const context: WarningContext = { engine: { kind: "local", gpu: true, cpuCores: 8 }, photoCount: 120 };

/** The warnings for the engine defaults with the given values changed. */
function warnings(changes: Record<string, OptionValue>, at: WarningContext = context): OptionWarning[] {
  return optionWarnings(options, { ...defaults, ...changes }, at);
}
const codes = (changes: Record<string, OptionValue>, at?: WarningContext) => warnings(changes, at).map((warning) => warning.code);

/** Each rule of section 6.5 of the desktop-class proposal: a combination it fires on, and near misses it stays silent on. */
const RULES: Array<{ code: OptionWarning["code"]; fires: Record<string, OptionValue>; rows: string[]; silent: Array<Record<string, OptionValue>>; at?: WarningContext }> = [
  { code: "warn.fast_orthophoto", fires: { "fast-orthophoto": true }, rows: ["fast-orthophoto"], silent: [{ "fast-orthophoto": false }] },
  { code: "warn.mesh_makes_model", fires: { "use-3dmesh": true, "skip-3dmodel": true }, rows: ["use-3dmesh", "skip-3dmodel"], silent: [{ "use-3dmesh": true }, { "skip-3dmodel": true }] },
  { code: "warn.ground_classifies", fires: { dtm: true }, rows: ["dtm"], silent: [{ dtm: false }, { dtm: true, "pc-classify": true }] },
  { code: "warn.cutline_crop", fires: { "orthophoto-cutline": true, crop: 0 }, rows: ["orthophoto-cutline", "crop"], silent: [{ "orthophoto-cutline": true }, { crop: 0 }] },
  { code: "warn.ignore_gsd", fires: { "ignore-gsd": true }, rows: ["ignore-gsd"], silent: [{ "ignore-gsd": false }] },
  { code: "warn.quality_point_cloud", fires: { "pc-quality": "high" }, rows: ["pc-quality"], silent: [{ "pc-quality": "medium" }, { "pc-quality": "low" }] },
  { code: "warn.quality_features", fires: { "feature-quality": "ultra" }, rows: ["feature-quality"], silent: [{ "feature-quality": "high" }, { "feature-quality": "lowest" }] },
  { code: "warn.quality_both", fires: { "pc-quality": "ultra", "feature-quality": "ultra" }, rows: ["feature-quality", "pc-quality"], silent: [{ "pc-quality": "ultra", "feature-quality": "high" }] },
  { code: "warn.hamming_cpu", fires: { "matcher-type": "hamming" }, rows: ["matcher-type"], at: { ...context, engine: { kind: "local", gpu: false, cpuCores: 8 } }, silent: [{ "matcher-type": "flann" }] },
  { code: "warn.planar", fires: { "sfm-algorithm": "planar" }, rows: ["sfm-algorithm"], silent: [{ "sfm-algorithm": "triangulation" }] },
  { code: "warn.processes_over_cores", fires: { "max-concurrency": 9 }, rows: ["max-concurrency"], silent: [{ "max-concurrency": 8 }, { "max-concurrency": 2 }] },
  { code: "warn.nothing_to_view", fires: { "skip-orthophoto": true, "skip-3dmodel": true }, rows: ["skip-orthophoto", "skip-3dmodel"], silent: [{ "skip-orthophoto": true }, { "skip-orthophoto": true, "skip-3dmodel": true, dsm: true }, { "skip-orthophoto": true, "skip-3dmodel": true, dtm: true }] },
  { code: "warn.end_with", fires: { "end-with": "odm_dem" }, rows: ["end-with"], silent: [{ "end-with": "odm_postprocess" }] },
  { code: "warn.rerun_from", fires: { "rerun-from": "odm_meshing" }, rows: ["rerun-from"], silent: [{ "rerun-from": "" }] },
  { code: "warn.split", fires: { split: 40 }, rows: ["split", "split-overlap"], silent: [{ split: 120 }, { split: 999999 }] },
  { code: "warn.cluster", fires: { "sm-cluster": "http://cluster.example.org:3000" }, rows: ["sm-cluster"], silent: [{ "sm-cluster": "None" }, { "sm-cluster": "" }] },
  { code: "warn.disk_space", fires: { "optimize-disk-space": true }, rows: ["optimize-disk-space"], silent: [{ "optimize-disk-space": false }] },
  { code: "warn.resolution_capped", fires: { "orthophoto-resolution": 2 }, rows: ["orthophoto-resolution"], silent: [{ "orthophoto-resolution": 5 }, { "orthophoto-resolution": 10 }, { "orthophoto-resolution": 2, "ignore-gsd": true }] },
  { code: "warn.no_ground_control", fires: { "use-exif": true }, rows: ["use-exif"], silent: [{ "use-exif": false }] },
];

test("the engine defaults raise no warning", () => {
  expect(warnings({})).toEqual([]);
});

test("there are seventeen rules, and the quality rule has a text for each raised option and one for both", () => {
  expect(WARNING_CODES).toHaveLength(19);
  expect(new Set(RULES.map((rule) => rule.code))).toEqual(new Set(WARNING_CODES));
});

for (const rule of RULES) {
  test(`${rule.code} fires on its combination, under its rows, and stays silent otherwise`, () => {
    const fired = warnings(rule.fires, rule.at).filter((warning) => warning.code === rule.code);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.options).toEqual(rule.rows);
    for (const changes of rule.silent) expect(codes(changes, rule.at), JSON.stringify(changes)).not.toContain(rule.code);
  });
}

test("the hamming warning needs a local engine that is known to use the CPU", () => {
  for (const engine of [{ kind: "local", gpu: true, cpuCores: 8 }, { kind: "local", gpu: null, cpuCores: 8 }, { kind: "remote", gpu: null, cpuCores: 8 }] as const) {
    expect(codes({ "matcher-type": "hamming" }, { ...context, engine })).not.toContain("warn.hamming_cpu");
  }
});

test("the process count warning needs the cores the engine reports, and says how many", () => {
  expect(codes({ "max-concurrency": 64 }, { ...context, engine: { ...context.engine, cpuCores: null } })).not.toContain("warn.processes_over_cores");
  expect(warnings({ "max-concurrency": 9 }).find((warning) => warning.code === "warn.processes_over_cores")?.data).toEqual({ cores: 8 });
});

test("the split warning needs the photo count", () => {
  expect(codes({ split: 40 }, { ...context, photoCount: null })).not.toContain("warn.split");
});

test("raising both quality settings says so once, for both", () => {
  const raised = codes({ "pc-quality": "high", "feature-quality": "ultra" });
  expect(raised.filter((code) => code.startsWith("warn.quality_"))).toEqual(["warn.quality_both"]);
});

test("the stop stage lists the outputs of every later stage, in the order the run makes them", () => {
  const lost = (stage: string) => warnings({ "end-with": stage }).find((warning) => warning.code === "warn.end_with")?.data;
  expect(lost("odm_report")).toEqual({ stage: "odm_report", lost: ["viewer-model"] });
  expect(lost("odm_orthophoto")).toEqual({ stage: "odm_orthophoto", lost: ["report", "viewer-model"] });
  expect(lost("odm_georeferencing")).toEqual({ stage: "odm_georeferencing", lost: ["elevation-models", "orthophoto", "report", "viewer-model"] });
  expect(lost("odm_meshing")).toEqual({ stage: "odm_meshing", lost: ["3d-model", "point-cloud", "elevation-models", "orthophoto", "report", "viewer-model"] });
  expect(lost("dataset")).toEqual({ stage: "dataset", lost: ["3d-model", "point-cloud", "elevation-models", "orthophoto", "report", "viewer-model"] });
});

test("both resolutions below the default share one warning, and the elevation model one needs an elevation model", () => {
  expect(warnings({ "orthophoto-resolution": 2, "dem-resolution": 2, dsm: true }).filter((warning) => warning.code === "warn.resolution_capped").map((warning) => warning.options)).toEqual([["dem-resolution", "orthophoto-resolution"]]);
  expect(codes({ "dem-resolution": 2 })).not.toContain("warn.resolution_capped");
  expect(warnings({ "dem-resolution": 2, dtm: true }).find((warning) => warning.code === "warn.resolution_capped")?.options).toEqual(["dem-resolution"]);
});

test("both ground control options share one warning", () => {
  expect(warnings({ "use-exif": true, "force-gps": true }).filter((warning) => warning.code === "warn.no_ground_control").map((warning) => warning.options)).toEqual([["force-gps", "use-exif"]]);
  expect(warnings({ "force-gps": true }).find((warning) => warning.code === "warn.no_ground_control")?.options).toEqual(["force-gps"]);
});

test("an option the engine does not offer raises nothing", () => {
  const without = options.filter((option) => option.name !== "fast-orthophoto");
  expect(optionWarnings(without, { ...defaults, "fast-orthophoto": true }, context)).toEqual([]);
});

test("the ground model warning stands when the engine does not offer point cloud classification, which it still turns on", () => {
  const without = options.filter((option) => option.name !== "pc-classify");
  expect(optionWarnings(without, { ...defaults, dtm: true }, context).map((warning) => warning.code)).toContain("warn.ground_classifies");
});

test("every warning names only rows of the catalogue", () => {
  const names = new Set(OPTION_CATALOGUE.map((option) => option.name));
  for (const rule of RULES) for (const warning of warnings(rule.fires, rule.at)) for (const name of warning.options) expect(names.has(name), name).toBe(true);
});

test("no warning blocks: each combination keeps every value and has no error", () => {
  for (const rule of RULES) {
    const resolved = resolveSettings(options, "custom", rule.fires, { bands: false, videos: false });
    expect(resolved.errors, rule.code).toEqual({});
    for (const [name, value] of Object.entries(rule.fires)) expect(resolved.values[name], name).toBe(value);
    expect(optionWarnings(options, resolved.values, rule.at ?? context).map((warning) => warning.code)).toContain(rule.code);
  }
});
