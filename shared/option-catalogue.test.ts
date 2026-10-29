import { expect, test } from "bun:test";
import { OPTION_CATALOGUE, PRESET_IDS } from "./option-catalogue.ts";

test("the catalogue accounts for every argument in the approved inventory", () => {
  expect(OPTION_CATALOGUE).toHaveLength(90);
  expect(new Set(OPTION_CATALOGUE.map((option) => option.name)).size).toBe(90);
  const count = (bin: string) => OPTION_CATALOGUE.filter((option) => option.bin === bin).length;
  expect(count("shown")).toBe(63);
  expect(count("server-set")).toBe(6);
  expect(count("file")).toBe(8);
  expect(count("distributed")).toBe(5);
  expect(count("engine")).toBe(8);
  expect(new Set(OPTION_CATALOGUE.filter((option) => option.bin === "shown").map((option) => option.group)).size).toBe(11);
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
    ["dsm", { "map-with-heights": true, "ground-model": true }],
    ["dtm", { "ground-model": true }],
    ["fast-orthophoto", { "quick-map": true }],
    ["texturing-skip-global-seam-leveling", { "multispectral-map": true }],
    ["radiometric-calibration", { "multispectral-map": "camera" }],
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
