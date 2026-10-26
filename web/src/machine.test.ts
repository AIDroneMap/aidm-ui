import { expect, test } from "bun:test";
import { messageParams } from "./machine.ts";

const GIB = 1024 ** 3;

test("sizes in bytes are shown in GiB", () => {
  const params = messageParams({ code: "machine.ram_low", data: { total: 12 * GIB, recommended: 16 * GIB } });
  expect(params).toEqual({ total: "12.0 GiB", recommended: "16.0 GiB" });
});

test("the minimum of an old macOS is a version, not bytes", () => {
  expect(messageParams({ code: "machine.macos_too_old", data: { minimum: 26 } })).toEqual({ minimum: 26 });
  expect(messageParams({ code: "machine.ram_too_low", data: { minimum: 8 * GIB } })).toEqual({ minimum: "8.0 GiB" });
});

test("a list becomes words separated by commas and other shapes are dropped", () => {
  const params = messageParams({ code: "machine.cpu_missing", data: { missing: ["avx2", "fma"], extra: { a: 1 } } });
  expect(params).toEqual({ missing: "avx2, fma" });
});
