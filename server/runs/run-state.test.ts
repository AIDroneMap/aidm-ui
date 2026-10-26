import { expect, test } from "bun:test";
import { isFinished, runStateFromTask, TASK_STATUS } from "./run-state.ts";

test("the task API's five codes map onto run states", () => {
  expect(runStateFromTask(TASK_STATUS.QUEUED, -1)).toBe("queued");
  expect(runStateFromTask(TASK_STATUS.RUNNING, 5000)).toBe("processing");
  expect(runStateFromTask(TASK_STATUS.FAILED, 5000)).toBe("failed");
  expect(runStateFromTask(TASK_STATUS.COMPLETED, 5000)).toBe("completed");
  expect(runStateFromTask(TASK_STATUS.CANCELED, -1)).toBe("cancelled");
});

test("running while initialising (processing time below zero, or missing) is queued", () => {
  expect(runStateFromTask(20, -1)).toBe("queued");
  expect(runStateFromTask(20, null)).toBe("queued");
  expect(runStateFromTask(20, 0)).toBe("processing");
});

test("any other code is unknown", () => {
  expect(runStateFromTask(99, 0)).toBe("unknown");
  expect(runStateFromTask("40", 0)).toBe("unknown");
  expect(runStateFromTask(null, 0)).toBe("unknown");
  expect(runStateFromTask(undefined, 0)).toBe("unknown");
});

test("completed, failed and cancelled are finished; the rest are not", () => {
  for (const state of ["completed", "failed", "cancelled"] as const) expect(isFinished(state)).toBe(true);
  for (const state of ["created", "uploading", "queued", "processing", "engine_unreachable", "unknown"] as const) {
    expect(isFinished(state)).toBe(false);
  }
});
