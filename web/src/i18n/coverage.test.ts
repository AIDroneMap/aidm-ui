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

test("all thirteen engine stages have a name and explanation", () => {
  const stages = ["dataset", "split", "merge", "opensfm", "openmvs", "odm_filterpoints", "odm_meshing", "mvs_texturing", "odm_georeferencing", "odm_dem", "odm_orthophoto", "odm_report", "odm_postprocess"];
  for (const stage of stages) {
    expect(messages[`run.stage.${stage}.name`]).toBeTruthy();
    expect(messages[`run.stage.${stage}.description`]).toBeTruthy();
  }
  expect(Object.keys(messages).filter((key) => key.startsWith("run.stage."))).toHaveLength(26);
});
