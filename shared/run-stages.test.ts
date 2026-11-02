import { expect, test } from "bun:test";
import { elapsedOf, FAILURE_LINES, failureOf, failureRange, isErrorLine, RUN_STAGES, stagesOf, stageStarted, type StageAnnouncement } from "./run-stages.ts";

const at = (minute: number) => `2026-11-02T10:${String(minute).padStart(2, "0")}:00.000Z`;
const seen = (...names: string[]): StageAnnouncement[] => names.map((name, index) => ({ name, line: index * 10, at: at(index) }));
const states = (list: ReturnType<typeof stagesOf>) => Object.fromEntries(list.map((stage) => [stage.name, stage.state]));

test("the engine's announcement of a stage is read from its log line", () => {
  expect(stageStarted("[INFO]    Running opensfm stage")).toBe("opensfm");
  expect(stageStarted("[INFO]    Finished opensfm stage")).toBeNull();
  expect(stageStarted("Running opensfm stage, said a photo name")).toBeNull();
});

test("before the engine announces a stage every stage waits, and split and merge are not listed", () => {
  const list = stagesOf([], null, "queued");
  expect(list.map((stage) => stage.name)).toEqual(RUN_STAGES.filter((name) => name !== "split" && name !== "merge"));
  expect(list.every((stage) => stage.state === "waiting" && stage.startedAt === null)).toBe(true);
});

test("the latest announced stage runs, the ones before it are done with the time they were seen, the rest wait", () => {
  const list = stagesOf(seen("dataset", "opensfm", "openmvs"), null, "processing");
  expect(states(list)).toMatchObject({ dataset: "done", opensfm: "done", openmvs: "running", odm_filterpoints: "waiting", odm_postprocess: "waiting" });
  expect(list.find((stage) => stage.name === "openmvs")?.startedAt).toBe(at(2));
  expect(list.find((stage) => stage.name === "odm_meshing")?.startedAt).toBeNull();
});

test("a stage the engine went past without announcing it is skipped while the run goes on", () => {
  expect(states(stagesOf(seen("dataset", "odm_dem"), null, "processing"))).toMatchObject({ dataset: "done", opensfm: "skipped", mvs_texturing: "skipped", odm_dem: "running", odm_orthophoto: "waiting" });
});

test("split and merge are listed once the engine announces them", () => {
  const list = stagesOf(seen("dataset", "split", "merge"), null, "processing");
  expect(states(list)).toMatchObject({ split: "done", merge: "running" });
  expect(list.map((stage) => stage.name).slice(0, 3)).toEqual(["dataset", "split", "merge"]);
});

test("when the run completes every announced stage is done and every other one skipped", () => {
  const list = stagesOf(seen("dataset", "opensfm", "odm_orthophoto", "odm_postprocess"), null, "completed");
  expect(states(list)).toMatchObject({ dataset: "done", opensfm: "done", openmvs: "skipped", odm_orthophoto: "done", odm_report: "skipped", odm_postprocess: "done" });
});

test("a failed run fails on the stage it was in, and the stages it never reached are skipped", () => {
  expect(states(stagesOf(seen("dataset", "opensfm"), null, "failed"))).toMatchObject({ dataset: "done", opensfm: "failed", openmvs: "skipped", odm_postprocess: "skipped" });
});

test("a cancelled run did not finish the stage it was in", () => {
  expect(states(stagesOf(seen("dataset", "opensfm"), null, "cancelled"))).toMatchObject({ dataset: "done", opensfm: "skipped", openmvs: "skipped" });
});

test("a run whose engine is not answering keeps its stage running", () => {
  expect(states(stagesOf(seen("dataset", "opensfm"), null, "engine_unreachable"))).toMatchObject({ opensfm: "running", openmvs: "waiting" });
});

test("after a restart only the stages of the engine's new start count", () => {
  const announced = [...seen("dataset", "opensfm"), { name: "dataset", line: 25, at: at(30) }];
  const list = stagesOf(announced, 20, "processing");
  expect(states(list)).toMatchObject({ dataset: "running", opensfm: "waiting" });
  expect(list[0]?.startedAt).toBe(at(30));
  expect(stagesOf(seen("dataset", "opensfm"), 20, "processing").every((stage) => stage.state === "waiting")).toBe(true);
});

test("the first announcement of a stage gives its start, a later one keeps it current", () => {
  const announced = [{ name: "opensfm", line: 1, at: at(1) }, { name: "dataset", line: 2, at: at(2) }, { name: "opensfm", line: 3, at: at(3) }];
  const list = stagesOf(announced, null, "processing");
  expect(states(list)).toMatchObject({ dataset: "done", opensfm: "running" });
  expect(list.find((stage) => stage.name === "opensfm")?.startedAt).toBe(at(1));
});

test("a stage the list does not know leaves none current, and the one before it done", () => {
  const announced = [...seen("dataset", "opensfm"), { name: "future_stage", line: 30, at: at(9) }];
  const list = stagesOf(announced, null, "processing");
  expect(list.some((stage) => stage.state === "running")).toBe(false);
  expect(states(list)).toMatchObject({ dataset: "done", opensfm: "done", openmvs: "waiting" });
});

test("announcements may arrive out of order and are read by their line", () => {
  expect(states(stagesOf([...seen("dataset", "opensfm")].reverse(), null, "processing"))).toMatchObject({ dataset: "done", opensfm: "running" });
});

test("the elapsed time is the engine's processing time once it reports one", () => {
  const now = Date.parse("2026-11-02T11:00:00Z");
  expect(elapsedOf({ state: "processing", processingTime: 95_000, createdAt: "2026-11-02T10:00:00Z" }, now)).toBe(95_000);
  expect(elapsedOf({ state: "completed", processingTime: 95_000, createdAt: "2026-11-02T10:00:00Z" }, now)).toBe(95_000);
});

test("before processing the elapsed time counts from the run's creation", () => {
  const now = Date.parse("2026-11-02T10:02:30Z");
  expect(elapsedOf({ state: "queued", processingTime: null, createdAt: "2026-11-02T10:00:00Z" }, now)).toBe(150_000);
  // The engine says -1 while it reads the uploaded photos: nothing is processing yet.
  expect(elapsedOf({ state: "uploading", processingTime: -1, createdAt: "2026-11-02T10:00:00Z" }, now)).toBe(150_000);
  // A clock behind the server never shows a negative time.
  expect(elapsedOf({ state: "created", processingTime: null, createdAt: "2026-11-02T10:05:00Z" }, now)).toBe(0);
});

test("a finished run the engine never processed has no elapsed time", () => {
  expect(elapsedOf({ state: "failed", processingTime: null, createdAt: "2026-11-02T10:00:00Z" }, Date.now())).toBeNull();
  expect(elapsedOf({ state: "queued", processingTime: null, createdAt: "not a date" }, Date.now())).toBeNull();
});

test("the failure range is the last lines of the log, never before the engine's latest start", () => {
  expect(failureRange(1000, null)).toEqual({ from: 1000 - FAILURE_LINES, to: 1000 });
  expect(failureRange(12, null)).toEqual({ from: 0, to: 12 });
  expect(failureRange(1000, 990)).toEqual({ from: 990, to: 1000 });
  expect(failureRange(0, null)).toEqual({ from: 0, to: 0 });
  expect(failureRange(5, 9)).toEqual({ from: 5, to: 5 });
});

test("error lines are the engine's own and Python's", () => {
  expect(isErrorLine("[ERROR]   The program could not process this dataset")).toBe(true);
  expect(isErrorLine("Traceback (most recent call last):")).toBe(true);
  expect(isErrorLine("ValueError: not enough values to unpack")).toBe(true);
  expect(isErrorLine("subprocess.CalledProcessError: Command returned 1")).toBe(true);
  expect(isErrorLine("[WARNING] No GPS information")).toBe(false);
  expect(isErrorLine("[INFO]    Running opensfm stage")).toBe(false);
  expect(isErrorLine("  reprojection error 0.4")).toBe(false);
});

test("the failure names the failing stage and places the first error line in the range", () => {
  const stages = stagesOf(seen("dataset", "opensfm"), null, "failed");
  const lines = ["[INFO]    matching", "[ERROR]   Out of memory", "Traceback (most recent call last):", "[INFO] done"];
  expect(failureOf(stages, { from: 96, to: 100 }, lines)).toEqual({ stage: "opensfm", from: 96, to: 100, errorLine: 97 });
  expect(failureOf(stagesOf([], null, "failed"), { from: 0, to: 1 }, ["[INFO] nothing wrong"])).toEqual({ stage: null, from: 0, to: 1, errorLine: null });
});
