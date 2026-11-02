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
  expect(messages["settings.port_invalid"]).toContain("{min}");
  expect(messages["settings.port_invalid"]).toContain("{max}");
  expect(messages["settings.passphrase_too_short"]).toContain("{min}");
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

import { OPTION_CATALOGUE, PRESET_IDS } from "../../../shared/option-catalogue.ts";

const fields = ["name", "description", "when", "cost", "example"];
const shown = OPTION_CATALOGUE.filter((option) => option.bin === "shown");

function catalogueErrors(texts: Record<string, string>, options = shown): string[] {
  const expected = new Set<string>();
  for (const option of options) {
    for (const field of fields) expected.add(`option.${option.name}.${field}`);
  }
  const errors = [...expected].filter((key) => !texts[key]?.trim());
  for (const key of Object.keys(texts)) {
    if (key.startsWith("option.") && key !== "option.invalid_value" && !expected.has(key)) errors.push(key);
  }
  return errors;
}

test("catalogue words cover exactly the five fields of each shown option", () => {
  expect(shown).toHaveLength(63);
  expect(catalogueErrors(messages)).toEqual([]);
});

test("catalogue coverage rejects missing, empty, unknown and removed option words", () => {
  const complete = Object.fromEntries(shown.flatMap(({ name }) => fields.map((field) => [`option.${name}.${field}`, "text"])));
  expect(catalogueErrors({ ...complete, "option.invalid_value": "invalid" })).toEqual([]);
  const missing = { ...complete };
  delete missing["option.dsm.name"];
  expect(catalogueErrors(missing)).toContain("option.dsm.name");
  expect(catalogueErrors({ ...complete, "option.dsm.name": "  " })).toContain("option.dsm.name");
  expect(catalogueErrors({ ...complete, "option.unknown.name": "text" })).toContain("option.unknown.name");
  expect(catalogueErrors(complete, shown.filter(({ name }) => name !== "dsm"))).toContain("option.dsm.name");
});

test("groups and presets have words and reasons match departures", () => {
  const groups = new Set(shown.map(({ group }) => group));
  expect(groups.size).toBe(11);
  for (const group of groups) expect(messages[`group.${group}`]?.trim()).toBeTruthy();
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
  expect(Object.keys(messages).filter((key) => key.startsWith("group.")).sort()).toEqual([...groups].map((group) => `group.${group}`).sort());
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
