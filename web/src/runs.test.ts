import { expect, test } from "bun:test";
import type { RunView } from "../../shared/api-types.ts";
import { EMPTY_LOG, MAX_LOG_LINES, isFinished, mergeLog, parseLogEvent, parseRunEvent } from "./runs.ts";

const run: RunView = {
  id: 4,
  projectId: 1,
  engineId: 2,
  engineName: "Barn",
  state: "processing",
  step: null,
  download: null,
  upload: null,
  progress: 45,
  engineMessage: null,
  problem: null,
  restarted: false,
  resultsAvailable: false,
  createdAt: "2026-10-26T10:00:00Z",
};

test("a run in an event is read", () => {
  expect(parseRunEvent(JSON.stringify(run))).toEqual(run);
});

test("anything that is not a run is refused", () => {
  expect(parseRunEvent("nope")).toBeNull();
  expect(parseRunEvent("[]")).toBeNull();
  expect(parseRunEvent(JSON.stringify({ ...run, state: "sleeping" }))).toBeNull();
  expect(parseRunEvent(JSON.stringify({ ...run, id: "4" }))).toBeNull();
  expect(parseRunEvent(JSON.stringify({ ...run, download: { received: 1 } }))).toBeNull();
});

test("a completed, failed or cancelled run is finished", () => {
  expect(isFinished({ ...run, state: "completed" })).toBe(true);
  expect(isFinished({ ...run, state: "failed" })).toBe(true);
  expect(isFinished({ ...run, state: "cancelled" })).toBe(true);
  expect(isFinished({ ...run, state: "engine_unreachable" })).toBe(false);
  expect(isFinished(run)).toBe(false);
});

test("log lines are appended in order", () => {
  const first = mergeLog(EMPTY_LOG, 0, ["a", "b"]);
  expect(mergeLog(first, 2, ["c"])).toEqual({ lines: ["a", "b", "c"], count: 3 });
});

test("lines that arrive twice are kept once", () => {
  const first = mergeLog(EMPTY_LOG, 0, ["a", "b"]);
  expect(mergeLog(first, 0, ["a", "b", "c"])).toEqual({ lines: ["a", "b", "c"], count: 3 });
  expect(mergeLog(first, 1, ["b"])).toBe(first);
});

test("lines that start after a gap are not added", () => {
  const first = mergeLog(EMPTY_LOG, 0, ["a"]);
  expect(mergeLog(first, 5, ["z"])).toBe(first);
});

test("only the newest lines are kept", () => {
  const many = Array.from({ length: MAX_LOG_LINES + 10 }, (_, index) => `line ${index}`);
  const log = mergeLog(EMPTY_LOG, 0, many);
  expect(log.lines).toHaveLength(MAX_LOG_LINES);
  expect(log.lines[0]).toBe("line 10");
  expect(log.count).toBe(MAX_LOG_LINES + 10);
  expect(mergeLog(log, MAX_LOG_LINES + 10, ["next"]).lines.at(-1)).toBe("next");
});

test("a log event is read", () => {
  expect(parseLogEvent('{"lines":["a"],"from":3}')).toEqual({ lines: ["a"], from: 3 });
  expect(parseLogEvent('{"lines":[1],"from":3}')).toBeNull();
  expect(parseLogEvent('{"lines":["a"]}')).toBeNull();
  expect(parseLogEvent("x")).toBeNull();
});
