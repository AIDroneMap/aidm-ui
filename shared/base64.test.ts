import { expect, test } from "bun:test";
import { base64ToBytes, bytesToBase64 } from "./base64.ts";

test("bytes survive a round trip, including a large array", () => {
  const bytes = new Uint8Array(300_000).map((_, i) => i % 251);
  expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  expect(bytesToBase64(new Uint8Array([104, 105]))).toBe("aGk=");
});

test("white space around the text is ignored, and text that is not base64 throws", () => {
  expect(base64ToBytes("  aGk=\n")).toEqual(new Uint8Array([104, 105]));
  expect(() => base64ToBytes("not base64!")).toThrow();
});
