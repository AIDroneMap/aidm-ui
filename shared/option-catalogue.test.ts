import { expect, test } from "bun:test";
import { AFFECTS, LOCK_REASONS, OPTION_CATALOGUE, OPTION_GROUPS, PRESET_IDS } from "./option-catalogue.ts";
import recorded from "../test-support/fixtures/task-api-2.7.0-options.json";

/** Section 6.2 of docs/proposals/0001-desktop-class-interface.md: every option the task API offers, placed once, in order. */
const PLACED: Record<string, string> = {
  "photos-and-cameras": "camera-lens rolling-shutter rolling-shutter-readout use-fixed-camera-params cameras gps-accuracy gps-z-offset force-gps use-exif radiometric-calibration primary-band skip-band-alignment video-limit video-resolution sky-removal bg-removal",
  "matching-and-reconstruction": "min-num-features feature-type feature-quality matcher-type matcher-neighbors matcher-order sfm-algorithm use-hybrid-bundle-adjustment sfm-no-partial",
  "point-cloud": "pc-quality pc-filter pc-sample pc-skip-geometric pc-classify smrf-scalar smrf-slope smrf-threshold smrf-window",
  "mesh-and-texture": "mesh-size mesh-octree-depth use-3dmesh skip-3dmodel texturing-skip-global-seam-leveling texturing-keep-unseen-faces texturing-single-material",
  "elevation-models": "dsm dtm dem-resolution dem-gapfill-steps dem-decimation dem-euclidean-map",
  "orthophoto": "fast-orthophoto skip-orthophoto orthophoto-resolution crop boundary auto-boundary auto-boundary-distance orthophoto-cutline",
  "outputs-and-formats": "orthophoto-png orthophoto-kmz orthophoto-compression orthophoto-no-tiled cog tiles pc-las pc-csv pc-copc pc-ept gltf 3d-tiles skip-report report-units",
  "performance-and-limits": "max-concurrency no-gpu optimize-disk-space ignore-gsd",
  "expert": "end-with rerun-from split split-overlap sm-cluster sm-no-align merge",
};
const NOT_OFFERED = ["project-path", "name", "rerun", "rerun-all", "version", "copy-to", "gcp", "geo", "align", "split-image-groups"];
const NEW_IN_ADR_0012 = ["max-concurrency", "no-gpu", "tiles", "pc-ept", "cog", "gltf", "cameras", "boundary", "use-exif", "force-gps", "split", "split-overlap", "sm-cluster", "sm-no-align", "merge", "end-with", "rerun-from"];

test("the nine groups hold the 80 options of the task API in order and the bin holds the ten it does not offer", () => {
  expect(OPTION_CATALOGUE).toHaveLength(90);
  expect(new Set(OPTION_CATALOGUE.map((option) => option.name)).size).toBe(90);
  expect(OPTION_GROUPS).toEqual(Object.keys(PLACED) as unknown as typeof OPTION_GROUPS);
  const shown = OPTION_CATALOGUE.filter((option) => option.bin === "shown");
  expect(shown.map((option) => option.name)).toEqual(Object.values(PLACED).flatMap((names) => names.split(" ")));
  for (const option of shown) expect(PLACED[option.group]!.split(" "), option.name).toContain(option.name);
  expect(Object.values(PLACED).map((names) => names.split(" ").length)).toEqual([16, 9, 9, 7, 6, 8, 14, 4, 7]);
  expect(OPTION_CATALOGUE.filter((option) => option.bin === "not-offered").map((option) => option.name)).toEqual(NOT_OFFERED);
  expect(OPTION_CATALOGUE.filter((option) => option.bin !== "shown" && option.bin !== "not-offered")).toEqual([]);
});

test("the 17 options ADR 0012 shows carry the facts the released task API reports", () => {
  const reported = new Map(recorded.map((option) => [option.name, option]));
  for (const name of NEW_IN_ADR_0012) {
    const entry = OPTION_CATALOGUE.find((option) => option.name === name);
    const option = reported.get(name)!;
    expect(entry?.bin, name).toBe("shown");
    if (entry?.bin !== "shown") continue;
    expect(entry.type, name).toBe(option.type as typeof entry.type);
    expect(entry.domain, name).toEqual(option.domain as typeof entry.domain);
    expect(String(entry.defaultValue), name).toBe(option.value);
    expect(entry.presets, name).toEqual({});
  }
});

test("only the three options the task API forces are locked, with their reason", () => {
  expect(LOCK_REASONS).toEqual(["always-on"]);
  const locked = OPTION_CATALOGUE.flatMap((option) => option.bin === "shown" && option.locked ? [[option.name, option.locked]] : []);
  expect(locked).toEqual([["cog", "always-on"], ["pc-ept", "always-on"], ["gltf", "always-on"]]);
});

test("every shown option has affects tags from the fixed set, each once, in the set's order", () => {
  expect(AFFECTS).toEqual(["quality", "time", "memory", "disk", "orthophoto", "surface-model", "ground-model", "point-cloud", "3d-model", "report"]);
  for (const option of OPTION_CATALOGUE) {
    if (option.bin !== "shown") continue;
    expect(option.affects.length, option.name).toBeGreaterThan(0);
    expect([...option.affects].sort((a, b) => AFFECTS.indexOf(a) - AFFECTS.indexOf(b)), option.name).toEqual([...new Set(option.affects)]);
  }
  const affects = (name: string) => {
    const entry = OPTION_CATALOGUE.find((option) => option.name === name);
    return entry?.bin === "shown" ? entry.affects : undefined;
  };
  expect(affects("feature-quality")).toEqual(["quality", "time", "memory"]);
  expect(affects("optimize-disk-space")).toEqual(["disk"]);
  // Section 6.2: crop and boundary also bound the elevation models.
  for (const name of ["crop", "boundary"]) expect(affects(name)).toEqual(expect.arrayContaining(["orthophoto", "surface-model", "ground-model"]));
});

test("shown options retain engine defaults and API domains", () => {
  const option = (name: string) => OPTION_CATALOGUE.find((entry) => entry.name === name);
  expect(option("feature-quality")).toMatchObject({
    type: "enum", domain: ["ultra", "high", "medium", "low", "lowest"], defaultValue: "high",
  });
  expect(option("mesh-octree-depth")).toMatchObject({ type: "int", domain: "integer: 1 <= x <= 14", defaultValue: 11 });
  expect(option("orthophoto-resolution")).toMatchObject({ type: "float", domain: "float > 0.0", defaultValue: 5 });
  expect(option("rolling-shutter")).toMatchObject({ type: "bool", domain: "", defaultValue: false });
  expect(option("primary-band")).toMatchObject({ type: "string", domain: "string", defaultValue: "auto" });
});

test("presets list only departures from the engine defaults", () => {
  expect(PRESET_IDS).toEqual(["quick-map", "map-with-heights", "3d-model", "ground-model", "multispectral-map", "custom"]);
  expect(OPTION_CATALOGUE.filter((entry) => entry.bin === "shown" && Object.keys(entry.presets).length).map((entry) => [entry.name, entry.bin === "shown" && entry.presets])).toEqual([
    ["radiometric-calibration", { "multispectral-map": "camera" }],
    ["texturing-skip-global-seam-leveling", { "multispectral-map": true }],
    ["dsm", { "map-with-heights": true, "ground-model": true }],
    ["dtm", { "ground-model": true }],
    ["fast-orthophoto", { "quick-map": true }],
  ]);
});

test("dependencies encode option alternatives and dataset facts", () => {
  const dependencies = (name: string) => {
    const entry = OPTION_CATALOGUE.find((item) => item.name === name);
    return entry?.bin === "shown" ? entry.dependencies : undefined;
  };
  expect(dependencies("smrf-slope")).toEqual([{ kind: "any", alternatives: [
    { kind: "option", name: "dtm", value: true }, { kind: "option", name: "pc-classify", value: true },
  ] }]);
  expect(dependencies("dem-resolution")).toEqual([{ kind: "any", alternatives: [
    { kind: "option", name: "dsm", value: true }, { kind: "option", name: "dtm", value: true },
  ] }]);
  expect(dependencies("rolling-shutter-readout")).toEqual([{ kind: "option", name: "rolling-shutter", value: true }]);
  expect(dependencies("auto-boundary-distance")).toEqual([{ kind: "option", name: "auto-boundary", value: true }]);
  expect(dependencies("primary-band")).toEqual([{ kind: "dataset", fact: "bands" }]);
  expect(dependencies("video-limit")).toEqual([{ kind: "dataset", fact: "videos" }]);
  expect(dependencies("feature-quality")).toEqual([]);
});

test("cost tags reflect explicit engine help", () => {
  const cost = (name: string) => {
    const entry = OPTION_CATALOGUE.find((item) => item.name === name);
    return entry?.bin === "shown" ? entry.costTag : undefined;
  };
  expect(cost("skip-3dmodel")).toBe("processing-time");
  expect(cost("skip-report")).toBe("processing-time");
  expect(cost("skip-orthophoto")).toBe("processing-time");
  expect(cost("fast-orthophoto")).toBe("processing-time");
  expect(cost("feature-quality")).toBe("processing-time-and-memory");
  expect(cost("camera-lens")).toBeNull();
});
