import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLogJson, stageStarted, summaryFromLogJson, summaryFromOutput, summaryLine } from "./run-summary.ts";

// In the shape the engine writes it (aidm: modules/log.py): local times without a zone, one entry per
// stage with its start and its messages, the last stage with its own end, and one entry per process.
const LOG_JSON = JSON.stringify({
  engine: "AIDM",
  version: "0.1.0",
  images: 73,
  startTime: "2026-10-27T01:07:00.250000",
  stages: [
    { name: "dataset", startTime: "2026-10-27T01:07:00.500000", messages: [{ message: "Found 73 usable images", type: "info" }] },
    { name: "opensfm", startTime: "2026-10-27T01:07:04", messages: [{ message: "Cannot write benchmark file", type: "warning" }] },
    {
      name: "odm_meshing",
      startTime: "2026-10-27T01:10:01.125000",
      messages: [
        { message: "PoissonRecon failed with 8 threads, let's retry with 4...", type: "warning" },
        { message: "PoissonRecon failed with 4 threads, let's retry with 2...", type: "warning" },
      ],
    },
    { name: "odm_report", startTime: "2026-10-27T01:13:00", endTime: "2026-10-27T01:13:35.5", totalTime: 35.5, messages: [] },
  ],
  processes: [
    { command: "opensfm ...", exitCode: 0 },
    { command: "PoissonRecon --threads 8 ...", exitCode: 1 },
    { command: "PoissonRecon --threads 4 ...", exitCode: 1 },
    { command: "PoissonRecon --threads 2 ...", exitCode: 0 },
  ],
  endTime: "2026-10-27T01:13:35.5",
  totalTime: 395.25,
  success: true,
});

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

test("the engine's log.json gives each stage's time, the warnings, the failed processes and the total", () => {
  expect(summaryFromLogJson(LOG_JSON)).toEqual({
    source: "log.json",
    stages: [
      { name: "dataset", seconds: 3.5 },
      { name: "opensfm", seconds: 177.1 },
      { name: "odm_meshing", seconds: 178.9 },
      { name: "odm_report", seconds: 35.5 },
    ],
    warnings: 3,
    failedProcesses: 2,
    engineSeconds: 395.3,
  });
  expect(summaryFromLogJson("not json")).toBeNull();
  expect(summaryFromLogJson(JSON.stringify({ engine: "AIDM" }))).toBeNull();
});

test("a task folder with its log.json is read, and one without is not", () => {
  const folder = mkdtempSync(join(tmpdir(), "aidm-run-summary-"));
  folders.push(folder);
  expect(readLogJson(folder)).toBeNull();
  writeFileSync(join(folder, "log.json"), LOG_JSON);
  expect(readLogJson(folder)?.failedProcesses).toBe(2);
  expect(readLogJson(null)).toBeNull();
});

test("from the task output: the warnings, and the stages timed as aidm-ui saw them start", () => {
  const lines = ["[INFO]    Running dataset stage", "[WARNING] Cannot write benchmark file", "[INFO]    Running opensfm stage", "  [WARNING] indented", "[INFO] done"];
  expect(stageStarted(lines[0] ?? "")).toBe("dataset");
  expect(stageStarted("[INFO]    Finished dataset stage")).toBeNull();
  const summary = summaryFromOutput(
    lines,
    [
      { name: "dataset", at: 1000 },
      { name: "opensfm", at: 4000 },
    ],
    10_500,
    395_250,
  );
  expect(summary).toEqual({
    source: "output",
    stages: [
      { name: "dataset", seconds: 3 },
      { name: "opensfm", seconds: 6.5 },
    ],
    warnings: 2,
    failedProcesses: null,
    engineSeconds: 395.3,
  });
});

test("the line says where the figures come from and where the engine keeps its task log", () => {
  const local = summaryLine({ id: 3, state: "completed", engineName: "this computer" }, summaryFromLogJson(LOG_JSON) as never, "/data/engine-data/abc/task_output.txt and log.json next to it");
  expect(local).toBe(
    'Run 3 summary: completed on "this computer"; the engine took 395.3 s; stages (from the engine\'s log.json): dataset 3.5 s, opensfm 177.1 s, odm_meshing 178.9 s, odm_report 35.5 s; 3 warnings; 2 failed processes; the engine\'s task log: /data/engine-data/abc/task_output.txt and log.json next to it',
  );
  const remote = summaryLine({ id: 4, state: "failed", engineName: "Barn" }, summaryFromOutput([], [], 0, null), "on the engine");
  expect(remote).toContain("the engine took an unknown time; stages (as AIDM UI's polls saw them, to within a poll): none seen; 0 warnings; failed processes not known from the output");
});
