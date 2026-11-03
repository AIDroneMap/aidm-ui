import { expect, test } from "bun:test";
import recorded from "../../../../test-support/fixtures/task-api-2.7.0-options.json";
import type { EngineOption } from "../../../../shared/engine-options.ts";
import { reconcileOptions } from "../../../../server/options/reconcile.ts";
import { resolveSettings } from "../../../../shared/run-settings.ts";
import { t } from "../../i18n/translate.ts";
import { changedCounts, changedFromDefault, compareRows, engineWords, invalidOptions, matchesSearch, optionRange, resetRow } from "./settings-view.ts";

const options = reconcileOptions(structuredClone(recorded) as EngineOption[]);
const facts = { bands: true, videos: true };
const option = (name: string) => options.find((item) => item.name === name)!;

test("search finds an option by its flag, its plain name and each of its other four texts, and nothing else", () => {
  const mesh = option("mesh-size");
  for (const query of ["mesh-size", ...["name", "description", "when", "cost", "example"].map((field) => t(`option.mesh-size.${field}`))]) {
    expect(matchesSearch(mesh, query.toLocaleUpperCase(), t)).toBe(true);
  }
  expect(matchesSearch(mesh, "  ", t)).toBe(true);
  expect(matchesSearch(mesh, "orthophoto-resolution", t)).toBe(false);
  const [unknown] = reconcileOptions([{ name: "future-option", type: "bool", value: "false", domain: "", help: "Makes the run faster" }]);
  expect(matchesSearch(unknown!, "faster", t)).toBe(true);
});

test("an option is changed when its value leaves the engine default or is not accepted, never when it is locked", () => {
  const resolved = resolveSettings(options, "quick-map", { dsm: true, "orthophoto-resolution": "bad", cog: false, "mesh-size": option("mesh-size").defaultValue }, facts);
  expect(changedFromDefault(option("fast-orthophoto"), resolved)).toBe(true);
  expect(changedFromDefault(option("dsm"), resolved)).toBe(true);
  expect(changedFromDefault(option("orthophoto-resolution"), resolved)).toBe(true);
  expect(changedFromDefault(option("mesh-size"), resolved)).toBe(false);
  expect(changedFromDefault(option("cog"), resolved)).toBe(false);
  const counts = changedCounts(options, resolved);
  expect(counts.get("elevation-models")).toBe(1);
  expect(counts.get("orthophoto")).toBe(2);
  expect(counts.get("mesh-and-texture")).toBeUndefined();
  expect(invalidOptions(options, resolved).map((item) => item.name)).toEqual(["orthophoto-resolution"]);
});

test("the comparison lists what differs from the defaults or from the preset, and a reset makes the row equal its reference", () => {
  const draft = { dsm: true, "fast-orthophoto": false, "orthophoto-resolution": "bad" };
  const resolved = resolveSettings(options, "quick-map", draft, facts);
  expect(compareRows("defaults", options, draft, resolved)).toEqual([
    { name: "dsm", reference: false, value: true },
    { name: "orthophoto-resolution", reference: 5, value: "bad" },
  ]);
  expect(compareRows("preset", options, draft, resolved)).toEqual([
    { name: "dsm", reference: false, value: true },
    { name: "fast-orthophoto", reference: true, value: false },
    { name: "orthophoto-resolution", reference: 5, value: "bad" },
  ]);
  // Back to the preset drops the edit; back to the default drops it too where the preset uses the default.
  expect(resetRow("preset", option("fast-orthophoto"), draft, resolved)).toEqual({ dsm: true, "orthophoto-resolution": "bad" });
  expect(resetRow("defaults", option("dsm"), draft, resolved)).toEqual({ "fast-orthophoto": false, "orthophoto-resolution": "bad" });
  const preset = resolveSettings(options, "quick-map", {}, facts);
  expect(resetRow("defaults", option("fast-orthophoto"), {}, preset)).toEqual({ "fast-orthophoto": false });
  expect(compareRows("defaults", options, { "fast-orthophoto": false }, resolveSettings(options, "quick-map", { "fast-orthophoto": false }, facts))).toEqual([]);
});

test("the allowed values are read from every domain shape the engine reports", () => {
  expect(optionRange(["low", "high"])).toEqual({ key: "settings.range.choices", data: { choices: "low, high" } });
  expect(optionRange("positive integer")).toEqual({ key: "settings.range.whole_from", data: { min: 0 } });
  expect(optionRange("negative float")).toEqual({ key: "settings.range.number_up_to", data: { max: 0 } });
  expect(optionRange("integer")).toEqual({ key: "settings.range.whole", data: {} });
  expect(optionRange("float: 1 <= x <= 5")).toEqual({ key: "settings.range.number_between", data: { min: 1, max: 5 } });
  expect(optionRange("integer > 0")).toEqual({ key: "settings.range.whole_above", data: { min: 0 } });
  expect(optionRange("float < 10")).toEqual({ key: "settings.range.number_below", data: { max: 10 } });
  expect(optionRange("percent")).toEqual({ key: "settings.range.percent", data: {} });
  expect(optionRange("json")).toEqual({ key: "settings.range.json", data: {} });
  for (const quiet of ["", "string", "path", "something new"]) expect(optionRange(quiet)).toBeNull();
  // Every key the recorded list needs has its words.
  for (const item of options) {
    const range = optionRange(item.domain);
    if (range) expect(t(range.key, range.data)).not.toBe(range.key);
  }
});

test("the engine's help reads as the engine prints it, with its default and choices filled in", () => {
  const [choice, number] = reconcileOptions([
    { name: "a", type: "enum", value: "high", domain: ["high", "low"], help: "Pick one of %(choices)s. Default: %(default)s" },
    { name: "b", type: "int", value: "50", domain: "percent", help: "Up to 100%%. Default: %(default)s" },
  ]);
  expect(engineWords(choice!)).toBe("Pick one of high, low. Default: high");
  expect(engineWords(number!)).toBe("Up to 100%. Default: 50");
  for (const item of options) expect(engineWords(item), item.name).not.toMatch(/%\(|%%/);
});
