import { expect, test } from "bun:test";
import { MESSAGE_CODES } from "../../../shared/message-codes.ts";
import en from "./en.json";

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
  expect(messages["network.unreachable"]).toBeTruthy();
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
