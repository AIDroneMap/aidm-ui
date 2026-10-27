import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatBytes, formatClock, formatDuration } from "./format.ts";

test("sizes under 1 GiB are whole MiB", () => {
  expect(formatBytes(888735308)).toBe("848 MiB");
  expect(formatBytes(5 * 1024 ** 2)).toBe("5 MiB");
});

test("sizes from 1 GiB have one decimal", () => {
  expect(formatBytes(1024 ** 3)).toBe("1.0 GiB");
  expect(formatBytes(7360806912)).toBe("6.9 GiB");
});

test("small sizes use KiB and bytes", () => {
  expect(formatBytes(2048)).toBe("2 KiB");
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(900)).toBe("900 B");
});

test("seconds read as minutes and seconds", () => {
  expect(formatDuration(1366)).toBe("22 min 46 s");
  expect(formatDuration(982)).toBe("16 min 22 s");
  expect(formatDuration(60)).toBe("1 min 0 s");
  expect(formatDuration(46)).toBe("46 s");
  expect(formatDuration(0)).toBe("0 s");
});

test("the time of day is the hour and the minutes on the local clock, in the locale this computer is set to", () => {
  const afternoon = new Date(2026, 9, 26, 14, 5);
  // Whatever the locale of the machine that runs the test, the clock is its locale's.
  const local = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(afternoon);
  expect(formatClock(afternoon.toISOString())).toBe(local);
  expect(formatClock(afternoon.toISOString())).toMatch(/05/);
});

test("no locale is written into the clock, so an Italian computer reads 14:05 and an American one 02:05 PM", () => {
  const source = readFileSync(join(import.meta.dir, "format.ts"), "utf8");
  const clock = /const clockFormat = new Intl\.DateTimeFormat\(([^,]*),/.exec(source)?.[1];
  expect(clock).toBe("undefined");
  // The same options give those two answers in those two locales.
  const at = new Date(2026, 9, 26, 14, 5);
  expect(new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" }).format(at)).toBe("14:05");
  expect(new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" }).format(at)).toMatch(/^02:05\s?PM$/);
});
