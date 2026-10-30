import { EMPTY_STAGE_PROGRESS, reduceStageProgress } from "./runs.ts";
import { expect, test } from "bun:test";
import type { RunView } from "../../shared/api-types.ts";
import { EMPTY_LOG, MAX_LOG_LINES, isFinished, linesWithRestart, mergeLog, parseLogEvent, parseRunEvent } from "./runs.ts";

const run: RunView = {
  name: null, preset: null, wayIn: null, sample: false,
  id: 4,
  projectId: 1,
  engineId: 2,
  engineName: "Barn",
  engineLocal: false,
  state: "processing",
  step: null,
  download: null,
  upload: null,
  progress: 45,
  engineMessage: null,
  problem: null,
  restarted: false,
  restartedAtLine: null,
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

test("a completed run fetching results remains live and its event is accepted", () => {
  const fetching = { ...run, state: "completed" as const, step: "results" as const, results: { state: "fetching" as const, archiveSize: null, outputs: [] } };
  expect(isFinished(fetching)).toBe(false);
  expect(parseRunEvent(JSON.stringify(fetching))).toEqual(fetching);
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

const SEPARATOR = "-- restarted --";

test("the separator goes in at the line where the engine's output began again", () => {
  const log = mergeLog(EMPTY_LOG, 0, ["old one", "old two", "new one"]);
  expect(linesWithRestart(log, 2, SEPARATOR)).toEqual(["old one", "old two", SEPARATOR, "new one"]);
});

test("the separator can come last, when the new output has not written a line yet", () => {
  const log = mergeLog(EMPTY_LOG, 0, ["old one", "old two"]);
  expect(linesWithRestart(log, 2, SEPARATOR)).toEqual(["old one", "old two", SEPARATOR]);
});

test("there is no separator for a run that never restarted, or when nothing came before it", () => {
  const log = mergeLog(EMPTY_LOG, 0, ["a", "b"]);
  expect(linesWithRestart(log, null, SEPARATOR)).toBe(log.lines);
  expect(linesWithRestart(log, 0, SEPARATOR)).toBe(log.lines);
});

test("the separator is counted from the first line the page dropped, and left out when its place was dropped", () => {
  const many = Array.from({ length: MAX_LOG_LINES + 10 }, (_, index) => `line ${index}`);
  const log = mergeLog(EMPTY_LOG, 0, many);
  // Line 10 is the first one still held.
  expect(linesWithRestart(log, 12, SEPARATOR).indexOf(SEPARATOR)).toBe(2);
  expect(linesWithRestart(log, 5, SEPARATOR)).toBe(log.lines);
});


test("stage remains after ordinary log lines leave it outside the display window", () => {
  let progress = reduceStageProgress(EMPTY_STAGE_PROGRESS, { from: 0, lines: ["Running odm_dem stage"] });
  let log = mergeLog(EMPTY_LOG, 0, ["Running odm_dem stage"]);
  const ordinary = Array(MAX_LOG_LINES).fill("working");
  progress = reduceStageProgress(progress, { from: 1, lines: ordinary });
  log = mergeLog(log, 1, ordinary);
  expect(log.lines).not.toContain("Running odm_dem stage");
  expect(progress.stage).toBe("odm_dem");
});

test("replaying saved pages retains the latest stage and rejects delayed older pages", () => {
  let progress = reduceStageProgress(EMPTY_STAGE_PROGRESS, { from: 0, lines: ["Running dataset stage", "working"] });
  progress = reduceStageProgress(progress, { from: 2, lines: ["Running odm_dem stage"] });
  progress = reduceStageProgress(progress, { from: 3, lines: Array(MAX_LOG_LINES).fill("working") });
  progress = reduceStageProgress(progress, { from: 0, lines: ["Running dataset stage"] });
  expect(progress.stage).toBe("odm_dem");
  expect(progress.line).toBe(2);
});

test("restart boundaries do not move backwards and ignore older stage lines", () => {
  let progress = reduceStageProgress(EMPTY_STAGE_PROGRESS, { from: 0, lines: ["Running dataset stage"] });
  progress = reduceStageProgress(progress, { restartedAtLine: 2 });
  expect(progress.stage).toBeNull();
  progress = reduceStageProgress(progress, { from: 2, lines: ["Running odm_dem stage"], restartedAtLine: 2 });
  progress = reduceStageProgress(progress, { from: 0, lines: ["Running dataset stage"], restartedAtLine: 1 });
  expect(progress).toMatchObject({ stage: "odm_dem", line: 2, restartedAtLine: 2 });
  progress = reduceStageProgress(progress, { from: 3, lines: ["Running future_stage stage"] });
  expect(progress).toMatchObject({ stage: null, line: 3 });
  progress = reduceStageProgress(progress, { from: 2, lines: ["Running odm_dem stage"] });
  expect(progress.stage).toBeNull();
});
