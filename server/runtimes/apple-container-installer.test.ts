import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { InstallStepId } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { ScriptedRunner, recorded, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import {
  APPLE_CONTAINER_INSTALLER,
  INSTALLER_POLL_MS,
  INSTALLER_WAIT_MS,
  KERNEL_DOWNLOAD_SIZE,
  MacSetup,
  macSteps,
  type InstallerPin,
  type MacSetupDeps,
} from "./apple-container-installer.ts";

/** Spelled out here on purpose: the installer puts the tool at this path, and it is the only one ever run. */
const TOOL = "/usr/local/bin/container";
const START = [TOOL, "system", "start", "--enable-kernel-install"];
const VERSION = [TOOL, "--version"];
const VERSION_LINE = "container CLI version 1.6.1 (build: release, commit: 804209b)\n";

let scratch: string;
let files: FakeFileServer;
let good: Uint8Array;
let pin: InstallerPin;

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

const installerPath = () => join(scratch, "downloads", "container-1.6.1-installer-signed.pkg");
const openArgv = () => ["open", installerPath()];

beforeEach(async () => {
  scratch = mkdtempSync(join(os.tmpdir(), "aidm-ui-mac-setup-"));
  good = new Uint8Array(20_000).map((_, index) => (index * 7) % 251);
  files = new FakeFileServer({ "/installer.pkg": good });
  await files.start();
  pin = { version: "1.6.1", url: files.url("/installer.pkg"), size: good.length, sha256: sha256(good) };
});

afterEach(async () => {
  await files.stop();
  rmSync(scratch, { recursive: true, force: true });
});

/** A clock that only the waits move. */
function clock() {
  const state = { now: 1_000_000, sleeps: [] as number[] };
  return {
    state,
    now: () => state.now,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.now += ms;
    },
  };
}

function setup(rules: ScriptedRule[], overrides: Partial<MacSetupDeps> = {}) {
  const runner = new ScriptedRunner(rules);
  const time = clock();
  const log: string[] = [];
  const service = new MacSetup({
    runner,
    dataFolder: scratch,
    installer: pin,
    freeBytes: () => 1e12,
    backoffMs: () => 0,
    sleep: time.sleep,
    now: time.now,
    log: (line) => log.push(line),
    ...overrides,
  });
  const steps: InstallStepId[] = [];
  const received: number[] = [];
  const run = (need: "tool_missing" | "service_stopped" = "tool_missing", signal?: AbortSignal, stopWaiting?: AbortSignal) =>
    service.run(need, { signal, stopWaiting, onStep: (step) => steps.push(step), onReceived: (bytes) => received.push(bytes) });
  return { runner, time, steps, received, run, service, log };
}

/** `container --version` answers once the third poll has come. */
function toolAppearsAfter(polls: number): ScriptedRule {
  let asked = 0;
  return {
    argv: VERSION,
    result: () =>
      ++asked > polls
        ? { exitCode: 0, stdout: VERSION_LINE, stderr: "" }
        : { exitCode: 127, stdout: "", stderr: "not found" },
  };
}

test("the installer is pinned in code to the release asset, with its size and SHA-256", () => {
  expect(APPLE_CONTAINER_INSTALLER).toEqual({
    version: "1.6.1",
    url: "https://github.com/apple/container/releases/download/1.6.1/container-1.6.1-installer-signed.pkg",
    size: 155965213,
    sha256: "cd47846819f06478d067060efe21e516b562ac0a9af8eecad6d5fea0b556b200",
  });
  expect(KERNEL_DOWNLOAD_SIZE).toBe(696573576);
});

test("a Mac without the tool gets four steps with their sizes, the kernel's from the tool's download and the startup files' unknown", () => {
  expect(macSteps("tool_missing")).toEqual([
    { id: "installer", size: 155965213 },
    { id: "approve", size: null },
    { id: "kernel", size: 696573576 },
    { id: "init", size: null },
  ]);
});

test("a Mac whose tool never ran gets only the kernel and the startup files, and the kernel's size is not known", () => {
  // 696573576 bytes was measured for release 1.6.1, which is the release this install puts on the Mac. A tool that was there before may be another one.
  expect(macSteps("service_stopped")).toEqual([
    { id: "kernel", size: null },
    { id: "init", size: null },
  ]);
});

// Criterion: the install flow verifies the installer checksum before opening it, and refuses a mismatch with a message code.

test("a corrupted installer is refused with download.checksum_mismatch and nothing is opened", async () => {
  const corrupted = good.slice();
  corrupted[100] = (corrupted[100] ?? 0) ^ 0xff;
  files.files.set("/installer.pkg", corrupted);
  const { run, runner, steps } = setup([{ argv: openArgv(), result: { exitCode: 0, stdout: "", stderr: "" } }]);

  expect(await run()).toEqual({ ok: false, step: "installer", error: { code: "download.checksum_mismatch", data: {} } });
  expect(runner.calls.some((call) => call[0] === "open")).toBe(false);
  expect(runner.calls.some((call) => call[0] === TOOL)).toBe(false);
  expect(steps).toEqual(["installer"]);
  // The wrong file is not left where the next run would find it.
  expect(existsSync(installerPath())).toBe(false);
});

test("an installer that is too long is refused the same way, and an unreachable one fails the download", async () => {
  files.files.set("/installer.pkg", new Uint8Array(good.length + 10));
  const long = setup([]);
  expect((await long.run()).ok).toBe(false);
  expect(long.runner.calls).toEqual([]);

  files.files.delete("/installer.pkg");
  const missing = setup([]);
  expect(await missing.run()).toEqual({ ok: false, step: "installer", error: { code: "download.failed", data: {} } });
  expect(missing.runner.calls).toEqual([]);
});

test("the installer is downloaded into the downloads folder, checked, and only then opened", async () => {
  const order: string[] = [];
  const rules: ScriptedRule[] = [
    {
      argv: openArgv(),
      result: () => {
        // By the time it is opened the checked file is in place and no partial file is.
        order.push(`open exists=${existsSync(installerPath())} part=${existsSync(`${installerPath()}.part`)}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    toolAppearsAfter(0),
    { argv: START, result: recorded("apple-container", "system-start") },
  ];
  const { run, received } = setup(rules);
  expect(await run()).toEqual({ ok: true });
  expect(order).toEqual(["open exists=true part=false"]);
  expect(received.at(-1)).toBe(good.length);
});

test("an installer that was downloaded and checked before is not downloaded again", async () => {
  const rules = [
    { argv: openArgv(), result: { exitCode: 0, stdout: "", stderr: "" } },
    toolAppearsAfter(0),
    { argv: START, result: recorded("apple-container", "system-start") },
  ];
  await setup(rules).run();
  const before = files.requests.length;
  await setup(rules).run();
  expect(files.requests.length).toBe(before);
});

// The approval step.

test("the approval opens the package once and then polls every 2 seconds until the tool answers", async () => {
  const { run, runner, time, steps } = setup([
    { argv: openArgv(), result: { exitCode: 0, stdout: "", stderr: "" } },
    toolAppearsAfter(3),
    { argv: START, result: recorded("apple-container", "system-start") },
  ]);
  expect(await run()).toEqual({ ok: true });
  expect(runner.calls.filter((call) => call[0] === "open")).toEqual([openArgv()]);
  expect(runner.calls.filter((call) => call.join(" ") === VERSION.join(" "))).toHaveLength(4);
  expect(time.state.sleeps).toEqual([INSTALLER_POLL_MS, INSTALLER_POLL_MS, INSTALLER_POLL_MS]);
  expect(steps).toEqual(["installer", "approve", "kernel", "init"]);
});

test("a tool that appears means --version exits 0 and prints the version line, not that a file exists", async () => {
  // A file that is there but does not answer yet (still being written, not allowed to run, printing something else) keeps the wait going.
  const answers = [
    { exitCode: 126, stdout: "", stderr: "permission denied" },
    { exitCode: 0, stdout: "", stderr: "" },
    { exitCode: 0, stdout: "usage: container\n", stderr: "" },
    { exitCode: 1, stdout: VERSION_LINE, stderr: "" },
    { exitCode: 0, stdout: VERSION_LINE, stderr: "" },
  ];
  let asked = 0;
  const { run, runner, time } = setup([
    { argv: openArgv(), result: { exitCode: 0, stdout: "", stderr: "" } },
    { argv: VERSION, result: () => answers[Math.min(asked++, answers.length - 1)] as { exitCode: number; stdout: string; stderr: string } },
    { argv: START, result: recorded("apple-container", "system-start") },
  ]);
  expect(await run()).toEqual({ ok: true });
  expect(runner.calls.filter((call) => call.join(" ") === VERSION.join(" "))).toHaveLength(5);
  expect(time.state.sleeps).toEqual([INSTALLER_POLL_MS, INSTALLER_POLL_MS, INSTALLER_POLL_MS, INSTALLER_POLL_MS]);
});

test("a container tool elsewhere on the search path is never run, so the wait ends in a timeout", async () => {
  const { run, runner } = setup([
    { argv: openArgv(), result: { exitCode: 0, stdout: "", stderr: "" } },
    { argv: ["container", "--version"], result: { exitCode: 0, stdout: VERSION_LINE, stderr: "" } },
    { argv: ["container", "system", "start", "--enable-kernel-install"], result: recorded("apple-container", "system-start") },
  ]);
  expect(await run()).toMatchObject({ ok: false, step: "approve", error: { data: { reason: "timeout" } } });
  expect(runner.calls.filter((call) => call[0] !== "open").every((call) => call[0] === TOOL)).toBe(true);
  expect(runner.calls.some((call) => call[0] === "container")).toBe(false);
});

test("a prompt nobody approves ends after 10 minutes with mac.install_not_finished", async () => {
  const { run, time, runner } = setup([{ argv: openArgv(), result: { exitCode: 0, stdout: "", stderr: "" } }]);
  expect(await run()).toEqual({
    ok: false,
    step: "approve",
    error: { code: "mac.install_not_finished", data: { reason: "timeout" } },
  });
  expect(time.state.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(INSTALLER_WAIT_MS);
  expect(runner.calls.some((call) => call.includes("start"))).toBe(false);
});

test("a package that cannot be opened ends the same way at once", async () => {
  const { run, time } = setup([{ argv: openArgv(), result: { exitCode: 1, stdout: "", stderr: "nope" } }]);
  expect(await run()).toEqual({
    ok: false,
    step: "approve",
    error: { code: "mac.install_not_finished", data: { reason: "open_failed" } },
  });
  expect(time.state.sleeps).toEqual([]);
});

test("the wait and the poll can be set, and the operator can cancel it", async () => {
  const short = setup([{ argv: openArgv(), result: { exitCode: 0, stdout: "", stderr: "" } }], { waitMs: 5000, pollMs: 1000 });
  expect((await short.run()).ok).toBe(false);
  expect(short.time.state.sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);

  const abort = new AbortController();
  const cancelled = setup([{ argv: openArgv(), result: () => (abort.abort(), { exitCode: 0, stdout: "", stderr: "" }) }]);
  expect(await cancelled.run("tool_missing", abort.signal)).toEqual({
    ok: false,
    step: "approve",
    error: { code: "download.cancelled", data: {} },
  });
});

test("the operator can stop waiting for the approval: the step ends in mac.install_not_finished with the reason cancelled", async () => {
  const stop = new AbortController();
  const { run, runner } = setup([
    { argv: openArgv(), result: { exitCode: 0, stdout: "", stderr: "" } },
    { argv: VERSION, result: () => (stop.abort(), { exitCode: 127, stdout: "", stderr: "not found" }) },
  ]);
  expect(await run("tool_missing", undefined, stop.signal)).toEqual({
    ok: false,
    step: "approve",
    error: { code: "mac.install_not_finished", data: { reason: "cancelled" } },
  });
  expect(runner.calls.some((call) => call.includes("start"))).toBe(false);
});

test("stopping the wait does not wait for the next poll", async () => {
  const stop = new AbortController();
  // A sleep that never ends, as if the poll were an hour long: only the stop can end the wait.
  const { run } = setup([{ argv: openArgv(), result: { exitCode: 0, stdout: "", stderr: "" } }], {
    sleep: () => {
      stop.abort();
      return new Promise<void>(() => {});
    },
  });
  expect(await run("tool_missing", undefined, stop.signal)).toMatchObject({
    ok: false,
    error: { code: "mac.install_not_finished", data: { reason: "cancelled" } },
  });
});

// The system service.

test("the system service starts with the kernel flag, never without it, and the kernel and startup files show as steps", async () => {
  const { run, runner, steps } = setup([{ argv: START, result: recorded("apple-container", "system-start") }]);
  expect(await run("service_stopped")).toEqual({ ok: true });
  expect(runner.calls).toEqual([START]);
  expect(runner.calls.every((call) => !(call.includes("start") && !call.includes("--enable-kernel-install")))).toBe(true);
  expect(steps).toEqual(["kernel", "init"]);
});

test("a failed start names the step it stopped in and its exit code", async () => {
  const { run } = setup([{ argv: START, result: recorded("apple-container", "system-start-failed") }]);
  expect(await run("service_stopped")).toEqual({
    ok: false,
    step: "kernel",
    error: { code: "mac.start_failed", data: { step: "kernel", exitCode: 1 } },
  });
});

test("a start that fails after the startup files began names that step", async () => {
  const { run } = setup([
    { argv: START, result: { exitCode: 1, stdout: "Launching container-apiserver...\nFetching init image...\n", stderr: "Error: boom\n" } },
  ]);
  expect(await run("service_stopped")).toMatchObject({ ok: false, step: "init", error: { code: "mac.start_failed" } });
});

test("a tool that never announces the startup files stays on the kernel step and still succeeds", async () => {
  const { run, steps } = setup([{ argv: START, result: { exitCode: 0, stdout: "Launching container-apiserver...\n", stderr: "" } }]);
  expect(await run("service_stopped")).toEqual({ ok: true });
  expect(steps).toEqual(["kernel"]);
});
