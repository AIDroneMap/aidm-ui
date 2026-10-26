import { expect, test } from "bun:test";
import { checkCaps, defaultCaps } from "./caps.ts";

const GiB = 1024 ** 3;

test("the default memory is the total less 2 GiB or 20 percent, whichever is larger", () => {
  // 20 percent of 9 GiB is 1.8 GiB, so the 2 GiB reserve wins.
  expect(defaultCaps(9 * GiB, 4).memoryBytes).toBe(7 * GiB);
  // 20 percent of 32 GiB is 6.4 GiB, which wins; the result is a whole number of bytes.
  expect(defaultCaps(32 * GiB, 8).memoryBytes).toBe(Math.floor(32 * GiB * 0.8));
  expect(Number.isInteger(defaultCaps(32 * GiB, 8).memoryBytes)).toBe(true);
});

test("the default CPUs are every core", () => {
  expect(defaultCaps(32 * GiB, 12).cpus).toBe(12);
});

test("caps from 1 GiB and 1 CPU up to the defaults pass", () => {
  const max = defaultCaps(32 * GiB, 8);
  expect(checkCaps({ memoryBytes: GiB, cpus: 1 }, max)).toEqual({ ok: true });
  expect(checkCaps(max, max)).toEqual({ ok: true });
});

test("memory below 1 GiB or above the default, or not whole, is refused with the limits", () => {
  const max = defaultCaps(32 * GiB, 8);
  const error = { code: "caps.memory_invalid" as const, data: { min: GiB, max: max.memoryBytes } };
  expect(checkCaps({ memoryBytes: GiB - 1, cpus: 2 }, max)).toEqual({ ok: false as const, error });
  expect(checkCaps({ memoryBytes: max.memoryBytes + 1, cpus: 2 }, max)).toEqual({ ok: false as const, error });
  expect(checkCaps({ memoryBytes: GiB + 0.5, cpus: 2 }, max)).toEqual({ ok: false as const, error });
});

test("CPUs below 1 or above all cores, or not whole, are refused with the limits", () => {
  const max = defaultCaps(32 * GiB, 8);
  const error = { code: "caps.cpus_invalid" as const, data: { min: 1, max: 8 } };
  expect(checkCaps({ memoryBytes: GiB, cpus: 0 }, max)).toEqual({ ok: false as const, error });
  expect(checkCaps({ memoryBytes: GiB, cpus: 9 }, max)).toEqual({ ok: false as const, error });
  expect(checkCaps({ memoryBytes: GiB, cpus: 1.5 }, max)).toEqual({ ok: false as const, error });
});
