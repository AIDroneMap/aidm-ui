import { expect, test } from "bun:test";
import { reconcileOptions } from "../server/options/reconcile.ts";
import { resolveSettings, rebaseSettings } from "./run-settings.ts";

const engine = reconcileOptions([
  { name: "dsm", type: "bool", domain: "", value: "false", help: "" },
  { name: "video-limit", type: "int", domain: "positive integer", value: "500", help: "" },
  { name: "new-option", type: "enum", domain: [1, true, "one"], value: "one", help: "" },
]);
const facts = { bands: null, videos: null };

test("resolves preset, invalid edits, unknown facts and engine options", () => {
  const result = resolveSettings(engine, "ground-model", { "video-limit": "", "new-option": 1 }, facts);
  expect(result.baseline.dsm).toBe(true);
  expect(result.errors["video-limit"]).toBe("type");
  expect(result.values["video-limit"]).toBeUndefined();
  expect(result.disabled["video-limit"]).toEqual([{ kind: "dataset", fact: "videos" }]);
  expect(result.overrides).toEqual([{ name: "new-option", value: 1 }]);
});

test("numeric text must be complete and within engine limits", () => {
  for (const value of ["", " ", "1e", "0x10", "9007199254740992", "-1"]) {
    const result = resolveSettings(engine, "custom", { "video-limit": value }, facts);
    expect(result.errors["video-limit"]).toBe(value === "-1" ? "domain" : "type");
    expect(result.overrides).toEqual([]);
  }
  expect(resolveSettings(engine, "custom", { "video-limit": "501" }, facts).overrides).toEqual([{ name: "video-limit", value: 501 }]);
  expect(resolveSettings(engine, "custom", { "new-option": true }, facts).values["new-option"]).toBe(true);
  expect(resolveSettings(engine, "custom", { "new-option": "1" }, facts).errors["new-option"]).toBe("domain");
});

test("option and alternative dependencies use valid effective values", () => {
  const dependent = { ...engine[0]!, name: "dependent", dependencies: [{ kind: "any" as const, alternatives: [{ kind: "option" as const, name: "dsm", value: true }, { kind: "dataset" as const, fact: "bands" as const }] }] };
  expect(resolveSettings([...engine, dependent], "custom", {}, facts).disabled.dependent).toEqual(dependent.dependencies);
  expect(resolveSettings([...engine, dependent], "ground-model", {}, facts).disabled.dependent).toBeUndefined();
  expect(resolveSettings([...engine, dependent], "custom", {}, { ...facts, bands: true }).disabled.dependent).toBeUndefined();
});

test("engine changes retain valid drafts and report changed values and schemas", () => {
  const next = reconcileOptions([
    { name: "dsm", type: "bool", domain: "", value: "true", help: "" },
    { name: "video-limit", type: "int", domain: "integer: 0 <= x <= 600", value: "400", help: "" },
    { name: "new-option", type: "string", domain: "string", value: "new", help: "" },
  ]);
  const result = rebaseSettings(engine, next, "custom", { "video-limit": "550", "new-option": true, removed: 3 }, facts);
  expect(result.draft).toEqual({ "video-limit": "550" });
  expect(result.moved).toContainEqual({ name: "dsm", before: false, after: true, changes: ["defaultValue", "value"] });
  expect(result.moved).toContainEqual({ name: "video-limit", before: 550, after: 550, changes: ["domain", "defaultValue"] });
  expect(result.moved).toContainEqual({ name: "new-option", before: true, after: "new", changes: ["type", "domain", "defaultValue", "value"] });
  expect(result.moved).toContainEqual({ name: "removed", changes: ["unavailable"] });
});


test("unknown names cannot inherit object properties in settings maps", () => {
  const options = reconcileOptions([{ name: "__proto__", type: "string", domain: "string", value: "initial", help: "Engine setting" }]);
  const draft = JSON.parse('{"__proto__":"edited"}');
  const result = resolveSettings(options, "custom", draft, facts);
  expect(Object.hasOwn(result.values, "__proto__")).toBe(true);
  expect(result.values["__proto__"]).toBe("edited");
  expect(result.errors["constructor"]).toBeUndefined();
  const rebased = rebaseSettings(options, options, "custom", draft, facts);
  expect(Object.hasOwn(rebased.draft, "__proto__")).toBe(true);
  expect(rebased.draft["__proto__"]).toBe("edited");
});

test("a preset value outside the engine schema stays invalid until explicitly corrected", () => {
  const changed = reconcileOptions([{ name: "dsm", type: "int", domain: "positive integer", value: "0", help: "Changed engine type" }]);
  expect(resolveSettings(changed, "ground-model", {}, facts).errors.dsm).toBe("type");
  const corrected = resolveSettings(changed, "ground-model", { dsm: "0" }, facts);
  expect(corrected.errors).toEqual({});
  expect(corrected.overrides).toEqual([{ name: "dsm", value: 0 }]);
});
