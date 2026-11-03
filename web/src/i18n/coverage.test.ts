import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGE_CODES } from "../../../shared/message-codes.ts";
import en from "./en.json";
import { UPLOAD_LOCAL_CODES } from "../upload/controller.ts";

const messages: Record<string, string> = en;

test("every message code has a translation", () => {
  const missing = MESSAGE_CODES.filter((code) => !(code in messages));
  expect(missing).toEqual([]);
});

test("ground control rejection has a translated server code", () => {
  expect(MESSAGE_CODES).toContain("upload.ground_control_unsupported");
  expect(messages["upload.ground_control_unsupported"]).toBeTruthy();
});

test("the interface-only code has a translation", () => {
  for (const code of ["network.unreachable", ...UPLOAD_LOCAL_CODES]) expect(messages[code]).toBeTruthy();
});

test("the placeholders the server fills are in the text", () => {
  expect(messages["preferences.port_invalid"]).toContain("{min}");
  expect(messages["preferences.port_invalid"]).toContain("{max}");
  expect(messages["preferences.passphrase_too_short"]).toContain("{min}");
});

test("no text uses an em dash or is empty", () => {
  for (const [key, text] of Object.entries(messages)) {
    expect(text.trim(), key).not.toBe("");
    expect(text, key).not.toContain("\u2014");
  }
});

const EM_DASH = "\u2014";
const WRITTEN = /\.(ts|tsx|css|md)$/;

/** The source, style and documentation files of the repository, tracked or new, that hold an em dash. */
function filesWithEmDash(paths: string[], read: (path: string) => string): string[] {
  return paths.filter((path) => WRITTEN.test(path) && read(path).includes(EM_DASH));
}

test("no source, style or documentation file uses an em dash", () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root });
  expect(listed.exitCode).toBe(0);
  const paths = listed.stdout.toString().split("\n").filter((path) => WRITTEN.test(path));
  expect(paths.length).toBeGreaterThan(100);
  expect(filesWithEmDash(paths, (path) => readFileSync(join(root, path), "utf8"))).toEqual([]);
});

test("the em dash check finds a dash in each kind of file and ignores other files", () => {
  const files: Record<string, string> = { "a.ts": `x ${EM_DASH} y`, "b.tsx": EM_DASH, "c.css": `/* ${EM_DASH} */`, "d.md": EM_DASH, "e.json": EM_DASH, "f.ts": "x - y" };
  expect(filesWithEmDash(Object.keys(files), (path) => files[path]!)).toEqual(["a.ts", "b.tsx", "c.css", "d.md"]);
});

import { AFFECTS, LOCK_REASONS, OPTION_CATALOGUE, OPTION_GROUPS, PRESET_IDS, type CatalogueOption } from "../../../shared/option-catalogue.ts";

const fields = ["name", "description", "when", "cost", "example"];
const facts = ["type", "domain", "defaultValue", "presets", "dependencies", "costTag", "affects", "locked"];
const shown = OPTION_CATALOGUE.filter((option) => option.bin === "shown");

/**
 * What keeps the catalogue from being complete: an entry in two places or in none, a shown entry
 * without one of its facts, and a missing, empty or unknown text in the translation file.
 */
function catalogueErrors(texts: Record<string, string>, entries: readonly CatalogueOption[] = OPTION_CATALOGUE): string[] {
  const errors: string[] = [];
  const places = new Map<string, number>();
  for (const entry of entries) places.set(entry.name, (places.get(entry.name) ?? 0) + 1);
  for (const [name, count] of places) if (count > 1) errors.push(`${name}: in ${count} places`);
  const expected = new Set<string>();
  for (const entry of entries) {
    if (entry.bin === "not-offered") continue;
    if (entry.bin !== "shown" || !(OPTION_GROUPS as readonly string[]).includes(entry.group)) { errors.push(`${entry.name}: in no group`); continue; }
    for (const fact of facts) if (!Object.hasOwn(entry, fact)) errors.push(`${entry.name}: no ${fact}`);
    if (!Array.isArray(entry.affects) || !entry.affects.length || entry.affects.some((tag) => !(AFFECTS as readonly string[]).includes(tag))) errors.push(`${entry.name}: affects`);
    if (entry.locked !== null && !(LOCK_REASONS as readonly string[]).includes(entry.locked)) errors.push(`${entry.name}: locked`);
    for (const field of fields) expected.add(`option.${entry.name}.${field}`);
  }
  for (const key of expected) if (!texts[key]?.trim()) errors.push(key);
  for (const key of Object.keys(texts)) {
    if (key.startsWith("option.") && key !== "option.invalid_value" && !expected.has(key)) errors.push(key);
  }
  for (const key of [...OPTION_GROUPS.map((group) => `settings.group.${group}`), ...AFFECTS.map((tag) => `affects.${tag}`), ...LOCK_REASONS.map((reason) => `settings.locked.${reason}`)]) {
    if (!texts[key]?.trim()) errors.push(key);
  }
  return errors;
}

test("every catalogue entry sits in one group or the bin, has its facts and has its texts", () => {
  expect(shown).toHaveLength(80);
  expect(catalogueErrors(messages)).toEqual([]);
});

test("catalogue coverage fails on an entry in two places or none, a missing fact, and a missing, empty or unknown text", () => {
  const complete = { ...messages };
  const dsm = shown.find(({ name }) => name === "dsm")!;
  expect(catalogueErrors({ ...complete, "option.gcp.name": "text" })).toEqual(["option.gcp.name"]);
  expect(catalogueErrors(complete, [...OPTION_CATALOGUE, { name: "dsm", bin: "not-offered" }])).toEqual(["dsm: in 2 places"]);
  expect(catalogueErrors(complete, OPTION_CATALOGUE.map((entry) => entry.name === "dsm" ? { ...dsm, group: "what-to-produce" } as unknown as CatalogueOption : entry))).toContain("dsm: in no group");
  const { affects: _, ...withoutAffects } = dsm;
  expect(catalogueErrors(complete, OPTION_CATALOGUE.map((entry) => entry.name === "dsm" ? withoutAffects as unknown as CatalogueOption : entry))).toEqual(["dsm: no affects", "dsm: affects"]);
  expect(catalogueErrors(complete, OPTION_CATALOGUE.map((entry) => entry.name === "dsm" ? { ...dsm, affects: ["speed"] } as unknown as CatalogueOption : entry))).toEqual(["dsm: affects"]);
  expect(catalogueErrors(complete, OPTION_CATALOGUE.map((entry) => entry.name === "dsm" ? { ...dsm, locked: "forced" } as unknown as CatalogueOption : entry))).toEqual(["dsm: locked"]);
  const missing = { ...complete };
  delete missing["option.split.when"];
  expect(catalogueErrors(missing)).toEqual(["option.split.when"]);
  expect(catalogueErrors({ ...complete, "option.dsm.name": "  " })).toEqual(["option.dsm.name"]);
  expect(catalogueErrors({ ...complete, "option.unknown.name": "text" })).toEqual(["option.unknown.name"]);
  expect(catalogueErrors(complete, OPTION_CATALOGUE.filter(({ name }) => name !== "dsm"))).toEqual(fields.map((field) => `option.dsm.${field}`));
  for (const key of ["settings.group.expert", "affects.disk", "settings.locked.always-on"]) {
    const without = { ...complete };
    delete without[key];
    expect(catalogueErrors(without)).toEqual([key]);
  }
});

test("groups, affects tags and presets have words and reasons match departures", () => {
  expect(OPTION_GROUPS).toHaveLength(9);
  expect(messages["catalogue.unexplained"]?.trim()).toBeTruthy();
  expect(PRESET_IDS).toHaveLength(6);
  const reasons = new Set<string>();
  for (const preset of PRESET_IDS) {
    expect(messages[`preset.${preset}.name`]?.trim()).toBeTruthy();
    expect(messages[`preset.${preset}.description`]?.trim()).toBeTruthy();
    for (const option of shown) {
      const value = option.presets[preset];
      if (value !== undefined && value !== option.defaultValue) reasons.add(`preset.${preset}.reason.${option.name}`);
    }
  }
  for (const key of reasons) expect(messages[key]?.trim(), key).toBeTruthy();
  expect(Object.keys(messages).filter((key) => /^preset\..+\.reason\./.test(key)).sort()).toEqual([...reasons].sort());
  expect(Object.keys(messages).filter((key) => key.startsWith("group."))).toEqual([]);
  expect(Object.keys(messages).filter((key) => key.startsWith("settings.group."))).toEqual(OPTION_GROUPS.map((group) => `settings.group.${group}`));
  expect(Object.keys(messages).filter((key) => key.startsWith("affects.") && key !== "affects.title")).toEqual(AFFECTS.map((tag) => `affects.${tag}`));
  expect(Object.keys(messages).filter((key) => key.startsWith("settings.locked."))).toEqual(LOCK_REASONS.map((reason) => `settings.locked.${reason}`));
  expect(Object.keys(messages).filter((key) => /^preset\.[^.]+\.(name|description)$/.test(key)).sort()).toEqual(PRESET_IDS.flatMap((preset) => [ `preset.${preset}.name`, `preset.${preset}.description` ]).sort());
});

test("all thirteen engine stages have a name and explanation", () => {
  const stages = ["dataset", "split", "merge", "opensfm", "openmvs", "odm_filterpoints", "odm_meshing", "mvs_texturing", "odm_georeferencing", "odm_dem", "odm_orthophoto", "odm_report", "odm_postprocess"];
  for (const stage of stages) {
    expect(messages[`run.stage.${stage}.name`]).toBeTruthy();
    expect(messages[`run.stage.${stage}.description`]).toBeTruthy();
  }
  expect(Object.keys(messages).filter((key) => key.startsWith("run.stage."))).toHaveLength(26);
});

/** The prefixes later work adds words under, each with the title it starts with. */
const RESERVED: Record<string, string> = {
  nav: "nav.label",
  "photos.visual": "photos.visual.title",
  settings: "settings.title",
  review: "review.title",
  runs: "runs.title",
  results: "results.title",
  details: "details.title",
  danger: "danger.title",
  affects: "affects.title",
  warn: "warn.title",
};

/** Prefixes whose keys do not sit together as one block of the file. */
function scatteredPrefixes(keys: string[], prefixes: string[]): string[] {
  return prefixes.filter((prefix) => {
    const places = keys.flatMap((key, index) => (key.startsWith(`${prefix}.`) ? [index] : []));
    return places.length === 0 || places[places.length - 1]! - places[0]! !== places.length - 1;
  });
}

test("every reserved prefix has its title and is one block of keys, with other keys between blocks", () => {
  for (const key of Object.values(RESERVED)) expect(messages[key]?.trim(), key).toBeTruthy();
  const keys = Object.keys(messages);
  expect(scatteredPrefixes(keys, Object.keys(RESERVED))).toEqual([]);
  // A block is never the last one of the file, so a new key there never changes the line before it.
  const last = keys[keys.length - 1]!;
  expect(Object.keys(RESERVED).some((prefix) => last.startsWith(`${prefix}.`))).toBe(false);
  // No two blocks touch, so changes under two prefixes never touch the same lines.
  const prefixOf = (key: string) => Object.keys(RESERVED).find((prefix) => key.startsWith(`${prefix}.`)) ?? null;
  const touching = keys.slice(1).flatMap((key, index) => {
    const [before, after] = [prefixOf(keys[index]!), prefixOf(key)];
    return before && after && before !== after ? [`${keys[index]} ${key}`] : [];
  });
  expect(touching).toEqual([]);
});

test("the block check finds a prefix split in two", () => {
  expect(scatteredPrefixes(["a.one", "a.two", "b.one", "a.three"], ["a", "b"])).toEqual(["a"]);
  expect(scatteredPrefixes(["a.one", "b.one"], ["a", "b", "c"])).toEqual(["c"]);
});

test("Preferences is the application's page and never calls itself settings", () => {
  expect(messages["nav.preferences"]).toBe("Preferences");
  expect(messages["preferences.title"]).toBe("Preferences");
  const wrong = Object.entries(messages).filter(([key, text]) => key.startsWith("preferences.") && /\bsettings?\b/i.test(text)).map(([key]) => key);
  expect(wrong).toEqual([]);
});
