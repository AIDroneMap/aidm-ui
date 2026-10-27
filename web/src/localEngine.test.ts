import { expect, test } from "bun:test";
import type { LocalEngineView } from "../../shared/api-types.ts";
import { caps, engineInstall, fresh, macInstall, macPlan } from "./localEngine.fixtures.ts";
import {
  appendLogLines,
  canInstall,
  capsRequest,
  finishedVersion,
  gibDraft,
  installStatus,
  installSteps,
  MAX_LOG_LINES,
  memoryBytesFromDraft,
  memoryInputMax,
  needsRuntimeSetup,
  parseLocalEngine,
  parseLogLines,
  parseRuntimeSetup,
  setupUnderWay,
  updateProblem,
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
    install: engineInstall({ stepReceived: 1000, speed: 500, layersDone: 3, layersTotal: 9, retries: 1, lastRetry: { code: "download.connection_silent", data: { seconds: 60 } } }),
  };
  expect(installStatus(pulling)).toEqual({
    kind: "downloading",
    graphics: false,
    size: 683 * 1024 ** 2,
    received: 1000,
    speed: 500,
    done: 3,
    total: 9,
    retries: 1,
    lastRetry: { code: "download.connection_silent", data: { seconds: 60 } },
  });
  expect(installStatus({ ...pulling, install: { ...pulling.install!, phase: "loading" } })).toEqual({ kind: "loading" });
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

test("the install status tells the graphics card package from the processor package and shows the test run and the deletion", () => {
  const gpu = { ...fresh, state: "installing" as const, install: engineInstall({ variant: "linux-amd64-gpu", size: 5_678_958_647 }) };
  expect(installStatus(gpu)).toMatchObject({ kind: "downloading", graphics: true, size: 5_678_958_647 });
  expect(installStatus({ ...gpu, install: { ...gpu.install, phase: "checking_gpu" } })).toEqual({ kind: "checking_gpu" });
  expect(installStatus({ ...gpu, install: { ...gpu.install, phase: "removing_gpu_package" } })).toEqual({
    kind: "removing_gpu_package",
    size: 5_678_958_647,
  });
  expect(canInstall({ ...gpu, install: { ...gpu.install, phase: "checking_gpu" } })).toBe(false);
});

test("the install button is offered only when nothing is installed and nothing is under way", () => {
  expect(canInstall(null)).toBe(false);
  expect(canInstall(fresh)).toBe(true);
  expect(canInstall({ ...fresh, install: engineInstall({ size: 1 }) })).toBe(false);
  expect(canInstall({ ...fresh, state: "failed", install: engineInstall({ phase: "failed", size: 1 }) })).toBe(true);
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

test("a runtime-setup event holds a phase and a problem, anything else is ignored", () => {
  expect(parseRuntimeSetup('{"phase":"installing","problem":null}')).toEqual({ phase: "installing", problem: null });
  expect(parseRuntimeSetup('{"phase":"failed","problem":{"code":"setup.dismissed","data":{}}}')?.problem?.code).toBe(
    "setup.dismissed",
  );
  expect(parseRuntimeSetup('{"phase":"later","problem":null}')).toBeNull();
  expect(parseRuntimeSetup('{"phase":"failed","problem":"x"}')).toBeNull();
  expect(parseRuntimeSetup("[]")).toBeNull();
  expect(parseRuntimeSetup("not json")).toBeNull();
});

const offer = {
  packageVersion: "2.5.0",
  engineVersion: "2.5.0",
  variant: "linux-amd64-cpu",
  kind: "container",
  size: 1,
  processorSize: null,
  source: "builtin",
  tag: null,
} as const;
const none = { ...fresh, runtime: { chosen: null, available: [], preferred: null } };

test("Podman is offered only on Linux with a package, no engine and no working tool", () => {
  expect(needsRuntimeSetup(none, offer)).toBe(true);
  expect(needsRuntimeSetup(fresh, offer)).toBe(false);
  expect(needsRuntimeSetup(none, null)).toBe(false);
  expect(needsRuntimeSetup(null, offer)).toBe(false);
  expect(needsRuntimeSetup(none, { ...offer, variant: "darwin-arm64" })).toBe(false);
  expect(needsRuntimeSetup(none, { ...offer, variant: "linux-amd64-gpu" })).toBe(true);
  // A Mac with no runtime runs the Linux arm64 package through Apple's tool, and is never offered Podman.
  const mac: LocalEngineView = { ...none, platform: "darwin" };
  expect(needsRuntimeSetup(mac, { ...offer, variant: "linux-arm64-cpu" })).toBe(false);
  const installed = { packageVersion: "2.5.0", variant: "linux-amd64-cpu", kind: "container", runtime: "podman" } as const;
  expect(needsRuntimeSetup({ ...none, installed }, offer)).toBe(false);
});

test("the setup is under way from the approval until it is done or has failed", () => {
  expect(setupUnderWay(null)).toBe(false);
  for (const phase of ["approval", "installing", "checking"] as const) expect(setupUnderWay({ phase, problem: null })).toBe(true);
  for (const phase of ["done", "failed"] as const) expect(setupUnderWay({ phase, problem: null })).toBe(false);
});

test("a Mac that sets up Apple's container tool reports the step, its size and the bytes so far", () => {
  const view: LocalEngineView = { ...fresh, state: "installing", install: macInstall("installer", { stepReceived: 1000 }) };
  expect(installStatus(view)).toEqual({ kind: "preparing", step: "installer", size: 155_965_213, received: 1000 });
  const approve: LocalEngineView = { ...fresh, state: "installing", install: macInstall("approve") };
  expect(installStatus(approve)).toEqual({ kind: "preparing", step: "approve", size: null, received: null });
  // The kernel and the startup files are downloads of known size, and the service start is not a download.
  const kernel: LocalEngineView = { ...fresh, state: "installing", install: macInstall("kernel", { stepReceived: 5000 }) };
  expect(installStatus(kernel)).toEqual({ kind: "preparing", step: "kernel", size: 696_573_576, received: 5000 });
  const init: LocalEngineView = { ...fresh, state: "installing", install: macInstall("init") };
  expect(installStatus(init)).toEqual({ kind: "preparing", step: "init", size: 69_425_005, received: null });
  const service: LocalEngineView = { ...fresh, state: "installing", install: macInstall("service") };
  expect(installStatus(service)).toEqual({ kind: "preparing", step: "service", size: null, received: null });
});

test("the steps come from the plan before the click and from the install after it, with where each stands", () => {
  expect(installSteps(null)).toEqual([]);
  expect(installSteps(fresh)).toEqual([]);
  expect(installSteps({ ...fresh, install: engineInstall() })).toEqual([]);
  expect(installSteps({ ...fresh, plan: macPlan }).map((step) => [step.id, step.state])).toEqual([
    ["installer", "pending"],
    ["approve", "pending"],
    ["service", "pending"],
    ["kernel", "pending"],
    ["init", "pending"],
    ["engine", "pending"],
  ]);
  const at = (step: Parameters<typeof macInstall>[0], phase: "preparing" | "pulling" | "failed" | "done" = "preparing") =>
    installSteps({ ...fresh, plan: macPlan, install: macInstall(step, { phase }) }).map((item) => item.state);
  expect(at("service")).toEqual(["done", "done", "current", "pending", "pending", "pending"]);
  expect(at("kernel")).toEqual(["done", "done", "done", "current", "pending", "pending"]);
  expect(at("approve", "failed")).toEqual(["done", "failed", "pending", "pending", "pending", "pending"]);
  expect(at("engine", "pulling")).toEqual(["done", "done", "done", "done", "done", "current"]);
  expect(at("engine", "done")).toEqual(["done", "done", "done", "done", "done", "done"]);
});

const applying = engineInstall({ phase: "starting", size: 1 });
const onVersion = (packageVersion: string, working: boolean): LocalEngineView => ({
  ...fresh,
  installed: { packageVersion, variant: "linux-amd64-cpu", kind: "container", runtime: "podman" },
  update: { ...fresh.update, applying: working ? applying : null },
});

test("a change of version is finished when the work ends with another version installed", () => {
  expect(finishedVersion(onVersion("2.5.0", true), onVersion("2.6.0", false))).toBe("2.6.0");
  expect(finishedVersion(onVersion("2.6.0", true), onVersion("2.5.0", false))).toBe("2.5.0");
  // Undone: the same version again. Still working, or not working before: nothing to say.
  expect(finishedVersion(onVersion("2.5.0", true), onVersion("2.5.0", false))).toBeNull();
  expect(finishedVersion(onVersion("2.5.0", true), onVersion("2.6.0", true))).toBeNull();
  expect(finishedVersion(onVersion("2.5.0", false), onVersion("2.6.0", false))).toBeNull();
});

test("the update block shows what an update says, and a download problem unless the engines list shows it", () => {
  const withProblem = (code: NonNullable<LocalEngineView["problem"]>["code"], state: LocalEngineView["state"]): LocalEngineView => ({ ...fresh, state, problem: { code, data: {} } });
  expect(updateProblem(withProblem("update.failed_rolled_back", "ready"))?.code).toBe("update.failed_rolled_back");
  expect(updateProblem(withProblem("install.pull_failed", "ready"))?.code).toBe("install.pull_failed");
  expect(updateProblem(withProblem("download.checksum_mismatch", "ready"))?.code).toBe("download.checksum_mismatch");
  expect(updateProblem(withProblem("install.unpack_failed", "ready"))?.code).toBe("install.unpack_failed");
  expect(updateProblem(withProblem("install.start_failed", "failed"))).toBeNull();
  expect(updateProblem(withProblem("engine.unreachable", "ready"))).toBeNull();
  expect(updateProblem(fresh)).toBeNull();
});
