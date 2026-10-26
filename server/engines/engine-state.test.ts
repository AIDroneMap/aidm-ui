import { expect, test } from "bun:test";
import { nextEngineStatus, UNREACHABLE_AFTER_FAILED_POLLS, type EngineStatus } from "./engine-state.ts";

const starting: EngineStatus = { state: "starting", failedPolls: 0 };

test("an engine with nothing waiting is ready and one with a queue is busy", () => {
  expect(nextEngineStatus(starting, { type: "answered", queueCount: 0 }).state).toBe("ready");
  expect(nextEngineStatus(starting, { type: "answered", queueCount: 1 }).state).toBe("busy");
  expect(nextEngineStatus({ state: "busy", failedPolls: 0 }, { type: "answered", queueCount: 0 }).state).toBe("ready");
});

test("an unknown queue length counts as ready", () => {
  expect(nextEngineStatus(starting, { type: "answered", queueCount: null }).state).toBe("ready");
});

test("an answer clears the run of failed polls", () => {
  const status = nextEngineStatus({ state: "ready", failedPolls: 2 }, { type: "answered", queueCount: 0 });
  expect(status).toEqual({ state: "ready", failedPolls: 0 });
});

test("an error body from the engine means failed at once", () => {
  expect(nextEngineStatus({ state: "ready", failedPolls: 1 }, { type: "refused" })).toEqual({
    state: "failed",
    failedPolls: 0,
  });
});

test("unreachable comes after three polls without an answer, not before", () => {
  expect(UNREACHABLE_AFTER_FAILED_POLLS).toBe(3);
  let status: EngineStatus = { state: "ready", failedPolls: 0 };
  status = nextEngineStatus(status, { type: "no_answer" });
  expect(status).toEqual({ state: "ready", failedPolls: 1 });
  status = nextEngineStatus(status, { type: "no_answer" });
  expect(status).toEqual({ state: "ready", failedPolls: 2 });
  status = nextEngineStatus(status, { type: "no_answer" });
  expect(status).toEqual({ state: "unreachable", failedPolls: 3 });
  status = nextEngineStatus(status, { type: "no_answer" });
  expect(status.state).toBe("unreachable");
});

test("an engine that never answered goes from starting to unreachable after three polls", () => {
  let status = starting;
  for (let i = 0; i < 2; i++) status = nextEngineStatus(status, { type: "no_answer" });
  expect(status.state).toBe("starting");
  status = nextEngineStatus(status, { type: "no_answer" });
  expect(status.state).toBe("unreachable");
});

test("an unreachable engine is ready again at its next answer", () => {
  const status = nextEngineStatus({ state: "unreachable", failedPolls: 5 }, { type: "answered", queueCount: 0 });
  expect(status).toEqual({ state: "ready", failedPolls: 0 });
});

test("the lifecycle events set their own state", () => {
  for (const type of ["installing", "starting", "stopped", "failed"] as const) {
    expect(nextEngineStatus({ state: "ready", failedPolls: 2 }, { type })).toEqual({ state: type, failedPolls: 0 });
  }
});
