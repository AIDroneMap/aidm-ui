// The lines follow the format string of Apple's container tool at 1.6.1
// (TerminalProgress/ProgressBar.swift) and the figures of the first real Mac
// test: an Italian Mac writes "215,4/593,9 MB" and "1,0 MB/s". The last test
// reads lines recorded in the second Mac test.
import { expect, test } from "bun:test";
import { recorded } from "../../test-support/scripted-runner.ts";
import { parseAppleProgress } from "./apple-progress.ts";

const MiB = 1024 ** 2;
const KiB = 1024;

test("a fetch line with a decimal comma gives the task, the percentage, the blobs, the bytes, the speed and the time", () => {
  expect(parseAppleProgress("[1/2] Fetching image 36% (3 of 9 blobs, 215,4/593,9 MB, 1,0 MB/s) [3m 34s]")).toEqual({
    task: 1,
    tasks: 2,
    description: "Fetching image",
    percent: 36,
    items: { done: 3, total: 9, name: "blobs" },
    bytes: { done: Math.round(215.4 * MiB), total: Math.round(593.9 * MiB) },
    speed: MiB,
    elapsedSeconds: 214,
  });
});

test("the same line with a decimal point, and a speed in KB/s, reads the same way", () => {
  const progress = parseAppleProgress("[1/2] Fetching image 50% (5 of 9 blobs, 297.0/593.9 MB, 512.3 KB/s) [9m 29s]");
  expect(progress?.bytes).toEqual({ done: Math.round(297 * MiB), total: Math.round(593.9 * MiB) });
  expect(progress?.speed).toBe(Math.round(512.3 * KiB));
  expect(progress?.elapsedSeconds).toBe(569);
});

test("bytes per second, and Zero KB when nothing has arrived, are speeds too", () => {
  expect(parseAppleProgress("[1/2] Fetching image 0% (0 of 9 blobs, Zero KB/s) [2s]")?.speed).toBe(0);
  const small = parseAppleProgress("[1/2] Fetching image 1% (1 of 9 blobs, 812/950 bytes, 812 bytes/s) [1s]");
  expect(small?.speed).toBe(812);
});

test("sizes in different units are kept apart and still read", () => {
  const progress = parseAppleProgress("Downloading kernel 12% (512,0 KB/664,3 MB, 1,0 MB/s) [1h 2m 3s]");
  expect(progress?.bytes).toEqual({ done: 512 * KiB, total: Math.round(664.3 * MiB) });
  expect(progress?.elapsedSeconds).toBe(3723);
  expect(progress?.task).toBeNull();
});

test("an unpacking line counts entries, grouped the way the locale groups them", () => {
  expect(parseAppleProgress("[2/2] Unpacking image 3% (1.234 of 41.200 entries) [1d 0h 0m 5s]")).toMatchObject({
    task: 2,
    description: "Unpacking image",
    percent: 3,
    items: { done: 1234, total: 41200, name: "entries" },
    bytes: null,
    elapsedSeconds: 86_405,
  });
});

test("a line that is not a progress line is null", () => {
  expect(parseAppleProgress("Installing base container filesystem...")).toBeNull();
  expect(parseAppleProgress("")).toBeNull();
});

test("the lines of a pull recorded on a Mac read as progress, and its error line does not", () => {
  const result = recorded("apple-container", "pull-stream-closed");
  const lines = result.stderr.trimEnd().split("\n");
  const error = lines.pop() ?? "";
  expect(error).toMatch(/^Error: StreamClosed/);
  expect(parseAppleProgress(error)).toBeNull();
  for (const line of lines) expect(parseAppleProgress(line), line).not.toBeNull();
  expect(parseAppleProgress(lines.at(-1) ?? "")).toMatchObject({ task: 1, tasks: 2, percent: 100, elapsedSeconds: 604 });
  expect(parseAppleProgress(lines[3] ?? "")).toMatchObject({ percent: 0, items: { done: 1, total: 11, name: "blobs" } });
});
