import { expect, test } from "bun:test";
import { parseSettingsFile, reconcileSettingsFile } from "./settings-file.ts";
import { reconcileOptions } from "../server/options/reconcile.ts";

test("a settings file round trips only option values, preset name and engine version", () => {
  const file = { options: [{ name: "dsm", value: true }, { name: "orthophoto-resolution", value: 8 }], preset: "Field map", engineVersion: "0.1.0" };
  expect(parseSettingsFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
  const options = reconcileOptions([{ name: "dsm", type: "bool", domain: "", value: "false", help: "" }, { name: "orthophoto-resolution", type: "float", domain: "positive float", value: "5", help: "" }]);
  expect(reconcileSettingsFile(file, options)).toEqual({ values: file.options, dropped: [] });
  expect(Object.keys(parseSettingsFile(file)!)).toEqual(["options", "preset", "engineVersion"]);
});

test("file reconciliation reports unsupported and invalid values without coercion", () => {
  const options = reconcileOptions([{ name: "dsm", type: "bool", domain: "", value: "false", help: "" }, { name: "orthophoto-resolution", type: "float", domain: "float: 1 <= x <= 5", value: "5", help: "" }, { name: "tiles", type: "bool", domain: "", value: "false", help: "" }]);
  const result = reconcileSettingsFile({ preset: "Old map", engineVersion: "older", options: [{ name: "dsm", value: true }, { name: "missing", value: 9 }, { name: "tiles", value: true }, { name: "orthophoto-resolution", value: 8 }] }, options);
  expect(result.values).toEqual([{ name: "dsm", value: true }]);
  expect(result.dropped).toEqual([{ name: "missing", value: 9, reason: "unavailable" }, { name: "tiles", value: true, reason: "unavailable" }, { name: "orthophoto-resolution", value: 8, reason: "domain" }]);
  expect(reconcileSettingsFile({ preset: "Map", engineVersion: null, options: [{ name: "dsm", value: "true" }] }, options).dropped).toEqual([{ name: "dsm", value: "true", reason: "type" }]);
});

test("file parsing rejects metadata, duplicate names, non-scalars and unbounded input", () => {
  const file = { options: [{ name: "dsm", value: true }], preset: "Map", engineVersion: null };
  for (const bad of [null, [], { ...file, token: "private" }, { options: file.options, preset: "Map" }, { ...file, options: [{ name: "dsm", value: {} }] }, { ...file, options: [{ name: "dsm", value: true, token: "private" }] }, { ...file, options: [file.options[0], file.options[0]] }, { ...file, options: Array.from({ length: 257 }, (_, i) => ({ name: String(i), value: true })) }, { ...file, preset: " " }, { ...file, preset: "a".repeat(201) }, { ...file, engineVersion: 1 }, { ...file, options: [{ name: "x", value: Infinity }] }]) expect(parseSettingsFile(bad)).toBeNull();
});

test("saved preset values are the reset baseline while editor changes remain separate", async () => {
  const { resolveSettings } = await import("./run-settings.ts");
  const options = reconcileOptions([{ name: "orthophoto-resolution", type: "float", domain: "positive float", value: "5", help: "" }]);
  const baseline = [{ name: "orthophoto-resolution", value: 8 }];
  const reset = resolveSettings(options, "custom", {}, { bands: null, videos: null }, baseline);
  expect(reset.baseline["orthophoto-resolution"]).toBe(8);
  expect(reset.values["orthophoto-resolution"]).toBe(8);
  expect(resolveSettings(options, "custom", { "orthophoto-resolution": "9" }, { bands: null, videos: null }, baseline).values["orthophoto-resolution"]).toBe(9);
});

test("engine reconciliation resets an invalid edit to the supported saved baseline", async () => {
  const { rebaseSettings } = await import("./run-settings.ts");
  const old = reconcileOptions([{ name: "orthophoto-resolution", type: "float", domain: "positive float", value: "5", help: "" }]);
  const next = reconcileOptions([{ name: "orthophoto-resolution", type: "float", domain: "float: 1 <= x <= 8", value: "5", help: "" }]);
  const values = [{ name: "orthophoto-resolution", value: 8 }];
  const changed = rebaseSettings(old, next, "custom", { "orthophoto-resolution": "9" }, { bands: null, videos: null }, { previous: values, next: values });
  expect(changed.draft).toEqual({});
  expect(changed.moved).toContainEqual({ name: "orthophoto-resolution", before: 9, after: 8, changes: ["domain", "value"] });
});
