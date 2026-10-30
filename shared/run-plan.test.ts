import { expect, test } from "bun:test";
import { OPTION_CATALOGUE, type PresetId } from "./option-catalogue.ts";
import type { ReconciledOption } from "./engine-options.ts";
import { planPreset, SERVER_OUTPUT_KEYS, type RunOutput } from "./run-plan.ts";

const options: ReconciledOption[] = OPTION_CATALOGUE.flatMap((option) =>
  option.bin === "shown" ? [{ ...option, domain: typeof option.domain === "string" ? option.domain : [...option.domain], unexplained: false, changes: [] }] : [],
);

test("the six presets use catalogue deltas and derive outputs", () => {
  const cases: Array<[PresetId, Array<[string, string | number | boolean]>, RunOutput[]]> = [
    ["quick-map", [["fast-orthophoto", true]], ["orthophoto", "report"]],
    ["map-with-heights", [["dsm", true]], ["orthophoto", "dsm", "3d-model", "report"]],
    ["3d-model", [], ["orthophoto", "3d-model", "report"]],
    ["ground-model", [["dsm", true], ["dtm", true]], ["orthophoto", "dsm", "dtm", "3d-model", "report"]],
    ["multispectral-map", [["texturing-skip-global-seam-leveling", true], ["radiometric-calibration", "camera"]], ["orthophoto", "3d-model", "report"]],
    ["custom", [], ["orthophoto", "3d-model", "report"]],
  ];
  for (const [preset, departures, outputs] of cases) {
    const plan = planPreset(preset, options);
    expect(plan.departures.map(({ name, value }) => [name, value])).toEqual(departures);
    expect(plan.outputs).toEqual(outputs);
  }
});

test("engine defaults win unless a supported preset explicitly sets the option", () => {
  const engine = options.filter((option) => option.name !== "dtm").map((option) =>
    option.name === "dsm" ? { ...option, defaultValue: true } : option,
  );
  const plan = planPreset("ground-model", engine);
  expect(plan.presetOptions).toEqual([{ name: "dsm", value: true }, { name: "dtm", value: true }]);
  expect(plan.unsupportedPresetOptions).toEqual([{ name: "dtm", value: true }]);
  expect(plan.departures).toEqual([]);
  expect(plan.effectiveOptions.find((option) => option.name === "dsm")?.value).toBe(true);
  expect(plan.outputs).toEqual(["orthophoto", "dsm", "3d-model", "report"]);
  expect(SERVER_OUTPUT_KEYS).toEqual(["pc-ept", "cog", "gltf", "tiles"]);
});

test("skip and fast flags suppress dependent outputs", () => {
  const enabled = new Set(["skip-orthophoto", "skip-3dmodel", "skip-report", "orthophoto-png", "orthophoto-kmz", "3d-tiles", "pc-las", "pc-csv", "pc-copc"]);
  const engine = options.map((option) => enabled.has(option.name) ? { ...option, defaultValue: true } : option);
  expect(planPreset("custom", engine).outputs).toEqual(["pc-las", "pc-csv", "pc-copc"]);
  const quick = options.map((option) => option.name === "3d-tiles" ? { ...option, defaultValue: true } : option);
  expect(planPreset("quick-map", quick).outputs).toEqual(["orthophoto", "report"]);
});

test("missing suppression flags do not promise dependent outputs", () => {
  const engine = options.filter((option) => !["skip-orthophoto", "skip-3dmodel", "skip-report", "fast-orthophoto"].includes(option.name));
  expect(planPreset("custom", engine).outputs).toEqual([]);
});
