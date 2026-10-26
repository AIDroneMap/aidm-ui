import { expect, test } from "bun:test";
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

test("the time of day is two digits for the hour and the minutes on the local clock", () => {
  const afternoon = formatClock(new Date(2026, 9, 26, 14, 5).toISOString());
  expect(afternoon).toMatch(/^02:05\s?PM$/);
  expect(formatClock(new Date(2026, 9, 26, 9, 30).toISOString())).toMatch(/^09:30\s?AM$/);
});
