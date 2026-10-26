import { expect, test } from "bun:test";
import type { LocalEngineView } from "../../shared/api-types.ts";
import { caps, fresh } from "./localEngine.fixtures.ts";
import {
  appendLogLines,
  canInstall,
  capsRequest,
  gibDraft,
  installStatus,
  MAX_LOG_LINES,
  memoryBytesFromDraft,
  memoryInputMax,
  parseLocalEngine,
  parseLogLines,
} from "./localEngine.ts";

const GIB = 1024 ** 3;

test("log lines are appended and only the newest 2000 are kept", () => {
  const first = Array.from({ length: 1990 }, (_, i) => `a${i}`);
  const second = Array.from({ length: 30 }, (_, i) => `b${i}`);
  const all = appendLogLines(first, second);
  expect(MAX_LOG_LINES).toBe(2000);
  expect(all).toHaveLength(2000);
  expect(all[0]).toBe("a20");
  expect(all[1999]).toBe("b29");
  expect(appendLogLines(["x"], [])).toEqual(["x"]);
  expect(appendLogLines(["x"], ["y"])).toEqual(["x", "y"]);
});

test("a log event holds lines, anything else is ignored", () => {
  expect(parseLogLines('{"lines":["one","two"]}')).toEqual(["one", "two"]);
  expect(parseLogLines('{"lines":[1]}')).toBeNull();
  expect(parseLogLines('{"line":"x"}')).toBeNull();
  expect(parseLogLines("not json")).toBeNull();
});

test("a local engine event is a view, anything else is ignored", () => {
  expect(parseLocalEngine(JSON.stringify(fresh))?.state).toBe("not_installed");
  expect(parseLocalEngine("[]")).toBeNull();
  expect(parseLocalEngine("{}")).toBeNull();
  expect(parseLocalEngine("nope")).toBeNull();
});

test("the install status follows the view", () => {
  expect(installStatus(null)).toEqual({ kind: "none" });
  expect(installStatus(fresh)).toEqual({ kind: "none" });
  const pulling: LocalEngineView = {
    ...fresh,
    state: "installing",
    install: { phase: "pulling", size: 683 * 1024 ** 2, layersDone: 3, layersTotal: 9, attempt: 2, maxAttempts: 5 },
  };
  expect(installStatus(pulling)).toEqual({
    kind: "downloading",
    size: 683 * 1024 ** 2,
    done: 3,
    total: 9,
    attempt: 2,
    maxAttempts: 5,
  });
  const starting: LocalEngineView = { ...pulling, state: "starting", install: { ...pulling.install!, phase: "starting" } };
  expect(installStatus(starting).kind).toBe("starting");
  const ready: LocalEngineView = {
    ...starting,
    state: "ready",
    installed: { packageVersion: "2.5.0", variant: "linux-amd64-cpu", kind: "container", runtime: "podman" },
    install: { ...pulling.install!, phase: "done" },
  };
  expect(installStatus(ready).kind).toBe("ready");
  const failed: LocalEngineView = { ...fresh, state: "failed", install: { ...pulling.install!, phase: "failed" } };
  expect(installStatus(failed).kind).toBe("failed");
});

test("the install button is offered only when nothing is installed and nothing is under way", () => {
  expect(canInstall(null)).toBe(false);
  expect(canInstall(fresh)).toBe(true);
  expect(canInstall({ ...fresh, install: { phase: "pulling", size: 1, layersDone: null, layersTotal: null, attempt: 1, maxAttempts: 5 } })).toBe(false);
  expect(canInstall({ ...fresh, state: "failed", install: { phase: "failed", size: 1, layersDone: null, layersTotal: null, attempt: 5, maxAttempts: 5 } })).toBe(true);
  expect(canInstall({ ...fresh, installed: { packageVersion: "2.5.0", variant: "linux-amd64-cpu", kind: "container", runtime: "podman" } })).toBe(false);
});

test("memory drafts are in GiB and an untouched draft keeps its exact bytes", () => {
  expect(gibDraft(14 * GIB)).toBe("14");
  expect(gibDraft(caps.maxMemoryBytes)).toBe("29.77");
  expect(memoryBytesFromDraft("29.77", caps.maxMemoryBytes)).toBe(caps.maxMemoryBytes);
  expect(memoryBytesFromDraft("4.5", 14 * GIB)).toBe(4.5 * GIB);
  expect(Number.isNaN(memoryBytesFromDraft("", 14 * GIB))).toBe(true);
  expect(memoryInputMax(caps.maxMemoryBytes)).toBe(29.7);
});

test("the caps request carries bytes and cores, and a wrong number is refused with the limits", () => {
  const ok = capsRequest("6", "4", caps);
  expect(ok).toEqual({ request: { memoryBytes: 6 * GIB, cpus: 4 } });
  const untouched = capsRequest("14", "8", caps);
  expect(untouched).toEqual({ request: { memoryBytes: 14 * GIB, cpus: 8 } });

  const low = capsRequest("0.5", "4", caps);
  expect("failure" in low && low.failure.code).toBe("caps.memory_invalid");
  expect("failure" in low && low.failure.data).toEqual({ min: GIB, max: caps.maxMemoryBytes });
  const high = capsRequest("40", "4", caps);
  expect("failure" in high && high.failure.code).toBe("caps.memory_invalid");
  const cores = capsRequest("6", "9", caps);
  expect("failure" in cores && cores.failure.code).toBe("caps.cpus_invalid");
  expect("failure" in cores && cores.failure.data).toEqual({ min: 1, max: 8 });
  const half = capsRequest("6", "2.5", caps);
  expect("failure" in half && half.failure.code).toBe("caps.cpus_invalid");
  const empty = capsRequest("", "4", caps);
  expect("failure" in empty && empty.failure.code).toBe("caps.memory_invalid");
});
