import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  MEMORY_CAP_MIN,
  MEMORY_RESERVE_MIN,
  MEMORY_RESERVE_SHARE,
  RAM_REFUSE_BELOW,
  RAM_WARN_BELOW,
  RUN_FREE_DISK,
  SAMPLE_JOB_PEAK_MEMORY,
} from "./thresholds.ts";

const ROOT = join(import.meta.dir, "..", "..");

function sources(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

test("the thresholds are the numbers the ticket sets", () => {
  expect(RAM_REFUSE_BELOW).toBe(8 * 1024 ** 3);
  expect(RAM_WARN_BELOW).toBe(16 * 1024 ** 3);
  expect(RUN_FREE_DISK).toBe(10 * 1024 ** 3);
});

test("the local engine keeps back 2 GiB or 20 percent, and the operator may go down to 1 GiB", () => {
  expect(MEMORY_RESERVE_MIN).toBe(2 * 1024 ** 3);
  expect(MEMORY_RESERVE_SHARE).toBe(0.2);
  expect(MEMORY_CAP_MIN).toBe(1024 ** 3);
});

test("no other file in the server or the test support defines them", () => {
  // 8, 16 or 10 times a gibibyte, however it is spelled.
  const gibibytes = /\b(8|16|10)\s*\*\s*(GiB\b|1024\s*\*\*\s*3|1024\s*\*\s*1024\s*\*\s*1024)/;
  const peak = /7_?360_?806_?912/;
  const offenders: string[] = [];
  for (const file of [...sources(join(ROOT, "server")), ...sources(join(ROOT, "test-support"))]) {
    const name = relative(ROOT, file);
    if (name === "server/machine/thresholds.ts" || name === "server/machine/thresholds.test.ts") continue;
    const text = readFileSync(file, "utf8");
    if (gibibytes.test(text) || peak.test(text)) offenders.push(name);
  }
  expect(offenders).toEqual([]);
});
