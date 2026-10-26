import { expect, test } from "bun:test";
import { compareVersions, isSupportedVersion } from "./versions.ts";

test("versions compare number by number, not as text", () => {
  expect(compareVersions("2.5.0", "2.5.0")).toBe(0);
  expect(compareVersions("2.10.1", "2.9.9")).toBe(1);
  expect(compareVersions("2.4.9", "2.5.0")).toBe(-1);
  expect(compareVersions("3", "2.9.9")).toBe(1);
});

test("missing parts count as zero", () => {
  expect(compareVersions("2.5", "2.5.0")).toBe(0);
  expect(compareVersions("2.5.0.1", "2.5")).toBe(1);
});

test("a pre-release sorts before its release and by its own name among pre-releases", () => {
  expect(compareVersions("2.6.0-rc1", "2.6.0")).toBe(-1);
  expect(compareVersions("2.6.0", "2.6.0-rc1")).toBe(1);
  expect(compareVersions("2.6.0-rc1", "2.6.0-rc2")).toBe(-1);
  expect(compareVersions("2.6.0-rc.2", "2.6.0-rc.10")).toBe(-1);
  expect(compareVersions("2.6.0-rc1", "2.5.9")).toBe(1);
});

test("text that is not a version cannot be compared", () => {
  expect(() => compareVersions("two", "2.5.0")).toThrow(RangeError);
  expect(() => compareVersions("2.5.0", "")).toThrow(RangeError);
});

test("2.5.0 and newer are supported, older and unreadable versions are not", () => {
  expect(isSupportedVersion("2.5.0")).toBe(true);
  expect(isSupportedVersion("2.6.0-rc1")).toBe(true);
  expect(isSupportedVersion("10.0.0")).toBe(true);
  expect(isSupportedVersion("2.4.9")).toBe(false);
  expect(isSupportedVersion("2.5.0-rc1")).toBe(false);
  expect(isSupportedVersion("2.4.0")).toBe(false);
  expect(isSupportedVersion("")).toBe(false);
  expect(isSupportedVersion("latest")).toBe(false);
});
