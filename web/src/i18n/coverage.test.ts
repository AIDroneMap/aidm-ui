import { expect, test } from "bun:test";
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
