import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { InstallStepId } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeRegistry, type AddedImage } from "../../test-support/fake-registry.ts";
import { ScriptedRunner, recorded, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import { imageFolder } from "../images/image-download.ts";
import {
  APPLE_CONTAINER_INIT_IMAGE,
  APPLE_CONTAINER_INSTALLER,
  APPLE_CONTAINER_KERNEL,
  INSTALLER_POLL_MS,
  INSTALLER_WAIT_MS,
  MacSetup,
  type InitImagePin,
  type InstallerPin,
  type KernelPin,
  type MacNeed,
  type MacSetupDeps,
} from "./apple-container-installer.ts";

/** Spelled out here on purpose: the installer puts the tool at this path, and it is the only one ever run. */
const TOOL = "/usr/local/bin/container";
const START = [TOOL, "system", "start", "--disable-kernel-install"];
const START_WITH_ITS_OWN_KERNEL = [TOOL, "system", "start", "--enable-kernel-install"];
const VERSION = [TOOL, "--version"];
const VERSION_LINE = "container CLI version 1.6.1 (build: release, commit: 804209b)\n";
/** Spelled out here on purpose: the tool looks for the startup files under exactly this name. */
const INIT_REFERENCE = "ghcr.io/apple/containerization/vminit:0.53.0";
const INSPECT_INIT = [TOOL, "image", "inspect", INIT_REFERENCE];
const LOAD = [TOOL, "image", "load"];
const OK = { exitCode: 0, stdout: "", stderr: "" };

/** Commands that would install again, replace, stop or remove what is on the Mac. No test run may issue one. */
const NEVER = ["--force", "system stop", "image delete", "uninstall"];

/** The tool is not there yet: install it, start its service, and nothing else is missing. */
const TOOL_ONLY: MacNeed = { tool: true, service: true, kernel: false, init: null, pinned: true };
const SERVICE_ONLY: MacNeed = { tool: false, service: true, kernel: false, init: null, pinned: true };
const KERNEL_ONLY: MacNeed = { tool: false, service: false, kernel: true, init: null, pinned: true };
const INIT_ONLY: MacNeed = { tool: false, service: false, kernel: false, init: "missing", pinned: true };

let scratch: string;
let files: FakeFileServer;
let registry: FakeRegistry;
let good: Uint8Array;
let kernelBytes: Uint8Array;
let initImage: AddedImage;
let pin: InstallerPin;
let kernelPin: KernelPin;
let initPin: InitImagePin;
const runners: ScriptedRunner[] = [];

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Deterministic bytes that differ from one seed to the next. */
function bytesOf(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + (i >> 8) * seed + seed) & 0xff);
}

const installerPath = () => join(scratch, "downloads", "container-1.6.1-installer-signed.pkg");
const kernelPath = () => join(scratch, "downloads", "kata-static-3.32.0-arm64.tar.zst");
const openArgv = () => ["open", installerPath()];
const kernelSetArgv = () => [
  TOOL,
  "system",
  "kernel",
  "set",
  "--tar",
  kernelPath(),
  "--binary",
  APPLE_CONTAINER_KERNEL.member,
  "--digest",
  `sha256:${kernelPin.sha256}`,
];
const initFolder = () => imageFolder(scratch, { repository: initPin.repository, digest: initPin.digest });

beforeEach(async () => {
  scratch = mkdtempSync(join(os.tmpdir(), "aidm-ui-mac-setup-"));
  good = new Uint8Array(20_000).map((_, index) => (index * 7) % 251);
  kernelBytes = bytesOf(60_000, 11);
  registry = new FakeRegistry();
  files = new FakeFileServer({ "/installer.pkg": good, "/kernel.tar.zst": kernelBytes });
  files.registry = registry;
  await files.start();
  initImage = registry.addImage({
    repository: "apple/containerization/vminit",
    config: bytesOf(1500, 3),
    layers: [bytesOf(40_000, 5), bytesOf(25_000, 7)],
  });
  pin = { version: "1.6.1", url: files.url("/installer.pkg"), size: good.length, sha256: sha256(good) };
  kernelPin = { ...APPLE_CONTAINER_KERNEL, url: files.url("/kernel.tar.zst"), size: kernelBytes.length, sha256: sha256(kernelBytes) };
  initPin = {
    ...APPLE_CONTAINER_INIT_IMAGE,
    repository: `${new URL(files.url("/")).host}/apple/containerization/vminit`,
    digest: initImage.digest,
    size: initImage.size,
  };
});

afterEach(async () => {
  // Whatever a test did, the tool, its kernel and its images were never replaced, stopped or removed.
  const calls = runners.splice(0).flatMap((runner) => runner.calls.map((call) => call.join(" ")));
  for (const forbidden of NEVER) expect(calls.filter((call) => call.includes(forbidden))).toEqual([]);
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

/** A setup on pins that point at the fake servers. By default the Mac has its kernel. */
function setup(rules: ScriptedRule[], overrides: Partial<MacSetupDeps> = {}) {
  const runner = new ScriptedRunner(rules);
  runners.push(runner);
  const time = clock();
  const log: string[] = [];
  const service = new MacSetup({
    runner,
    dataFolder: scratch,
    installer: pin,
    kernel: kernelPin,
    initImage: initPin,
    kernelPresent: () => true,
    freeBytes: () => 1e12,
    backoffMs: () => 0,
    sleep: time.sleep,
    now: time.now,
    log: (line) => log.push(line),
    ...overrides,
  });
  const steps: InstallStepId[] = [];
  const received: number[] = [];
  const run = (need: MacNeed = TOOL_ONLY, signal?: AbortSignal, stopWaiting?: AbortSignal) =>
    service.run(need, { signal, stopWaiting, onStep: (step) => steps.push(step), onReceived: (bytes) => received.push(bytes) });
  return { runner, time, steps, received, run, service, log };
}

/** A setup on the real pins, for the questions that only look. */
function looking(rules: ScriptedRule[], kernelThere: boolean) {
  const runner = new ScriptedRunner(rules);
  runners.push(runner);
  const service = new MacSetup({ runner, dataFolder: scratch, kernelPresent: () => kernelThere, log: () => {} });
  return { runner, service };
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

/**
 * The tool's answers about the startup files: it holds them from the start or
 * from the load on. `listed` is the manifest digest its inspect names.
 */
function startupFiles(there: boolean, options: { named?: string; onLoad?: () => void } = {}) {
  const state = { loaded: false };
  const rules: ScriptedRule[] = [
    {
      argv: INSPECT_INIT,
      // The tool hides its startup files from inspect: an empty list when they are there (recorded on a real Mac).
      result: () =>
        there || state.loaded ? recorded("apple-container", "image-inspect-init-present") : recorded("apple-container", "image-inspect-init-missing"),
    },
    {
      argv: LOAD,
      result: () => {
        state.loaded = true;
        options.onLoad?.();
        return options.named === undefined ? recorded("apple-container", "image-load-init") : { exitCode: 0, stdout: `${options.named}\n`, stderr: "" };
      },
    },
  ];
  return { state, rules };
}

// The pins.

test("the installer is pinned in code to the release asset, with its size and SHA-256", () => {
  expect(APPLE_CONTAINER_INSTALLER).toEqual({
    version: "1.6.1",
    url: "https://github.com/apple/container/releases/download/1.6.1/container-1.6.1-installer-signed.pkg",
    size: 155965213,
    sha256: "cd47846819f06478d067060efe21e516b562ac0a9af8eecad6d5fea0b556b200",
  });
});

test("the kernel is pinned in code to the Kata release the tool names, with its size, SHA-256 and the file inside", () => {
  expect(APPLE_CONTAINER_KERNEL).toEqual({
    forTool: "1.6.1",
    version: "3.32.0",
    url: "https://github.com/kata-containers/kata-containers/releases/download/3.32.0/kata-static-3.32.0-arm64.tar.zst",
    size: 696573576,
    sha256: "8736c054d9223974735394f822000823baef509e1c33405ec798240fa9b6e4b5",
    member: "opt/kata/share/kata-containers/vmlinux-6.18.35-197-debug",
  });
  // The archive is saved under the name the URL ends with.
  expect(APPLE_CONTAINER_KERNEL.url.endsWith(`/kata-static-${APPLE_CONTAINER_KERNEL.version}-arm64.tar.zst`)).toBe(true);
});

test("the startup files are pinned in code to the image the tool looks for, with the arm64 manifest digest and its size", () => {
  expect(APPLE_CONTAINER_INIT_IMAGE).toEqual({
    forTool: "1.6.1",
    reference: "ghcr.io/apple/containerization/vminit:0.53.0",
    repository: "ghcr.io/apple/containerization/vminit",
    digest: "sha256:d44abd139d712965bf29ecd58f0c6af99017c1c13cf74eed645cb1fd2d5122cd",
    size: 69425005,
  });
  expect(APPLE_CONTAINER_INIT_IMAGE.reference.startsWith(`${APPLE_CONTAINER_INIT_IMAGE.repository}:`)).toBe(true);
});

test("moving the installer pin to another release means moving the kernel pin and the startup files pin with it", () => {
  const message =
    "The installer pin is for another release than the kernel pin or the startup files pin. " +
    "Read the new release's source (ContainerSystemConfig.swift), then move the kernel pin and the startup files pin in the same change, measuring the size and the SHA-256 again.";
  expect(APPLE_CONTAINER_KERNEL.forTool, message).toBe(APPLE_CONTAINER_INSTALLER.version);
  expect(APPLE_CONTAINER_INIT_IMAGE.forTool, message).toBe(APPLE_CONTAINER_INSTALLER.version);
});

// What a Mac needs, found by looking.

test("a Mac without the tool needs the installer, the approval, the service, the kernel and the startup files, with their sizes", async () => {
  const { service, runner } = looking([], false);
  const need = await service.need("tool_missing", null);
  expect(need).toEqual({ tool: true, service: true, kernel: true, init: "unknown", pinned: true });
  expect(service.steps(need as MacNeed)).toEqual([
    { id: "installer", size: 155965213 },
    { id: "approve", size: null },
    { id: "network", size: null },
    { id: "service", size: null },
    { id: "kernel", size: 696573576 },
    { id: "init", size: 69425005 },
  ]);
  // An engine reached through a socket needs no Local Network permission, so that step goes.
  expect(service.steps(need as MacNeed, { localNetwork: false }).map((step) => step.id)).toEqual(["installer", "approve", "service", "kernel", "init"]);
  // The startup files can only be asked for while the service runs, so nothing was asked.
  expect(runner.calls).toEqual([]);
});

test("a Mac whose service is stopped but whose kernel is there needs the service and the startup files, not the kernel", async () => {
  const { service, runner } = looking([], true);
  const need = await service.need("service_stopped", "1.6.1");
  expect(need).toEqual({ tool: false, service: true, kernel: false, init: "unknown", pinned: true });
  expect(service.steps(need as MacNeed)).toEqual([
    { id: "service", size: null },
    { id: "init", size: 69425005 },
  ]);
  expect(runner.calls).toEqual([]);
});

test("a Mac that has the tool running, its kernel and its startup files needs nothing, and the tool was asked about the startup files", async () => {
  const { service, runner } = looking([{ argv: INSPECT_INIT, result: recorded("apple-container", "image-inspect-init-present") }], true);
  expect(await service.need("running", "1.6.1")).toBeNull();
  expect(runner.calls).toEqual([INSPECT_INIT]);
});

test("a Mac with the tool running but no kernel needs the kernel, and the startup files only when the tool does not hold them", async () => {
  const held = looking([{ argv: INSPECT_INIT, result: OK }], false);
  const withFiles = await held.service.need("running", "1.6.1");
  expect(withFiles).toEqual({ tool: false, service: false, kernel: true, init: null, pinned: true });
  expect(held.service.steps(withFiles as MacNeed)).toEqual([{ id: "kernel", size: 696573576 }]);

  const lacking = looking([{ argv: INSPECT_INIT, result: { exitCode: 1, stdout: "", stderr: "Error: notFound: image not found\n" } }], false);
  const withoutFiles = await lacking.service.need("running", "1.6.1");
  expect(withoutFiles).toEqual({ tool: false, service: false, kernel: true, init: "missing", pinned: true });
  expect(lacking.service.steps(withoutFiles as MacNeed)).toEqual([
    { id: "kernel", size: 696573576 },
    { id: "init", size: 69425005 },
  ]);
});

test("a Mac with everything but the startup files needs only the startup files", async () => {
  const { service } = looking([{ argv: INSPECT_INIT, result: { exitCode: 1, stdout: "", stderr: "Error: notFound: image not found\n" } }], true);
  const need = await service.need("running", "1.6.1");
  expect(need).toEqual({ tool: false, service: false, kernel: false, init: "missing", pinned: true });
  expect(service.steps(need as MacNeed)).toEqual([{ id: "init", size: 69425005 }]);
});

test("a tool of another release with its service stopped and no kernel needs the service and a kernel of unknown size, and no startup files", async () => {
  const { service, runner } = looking([], false);
  const need = await service.need("service_stopped", "1.5.0");
  expect(need).toEqual({ tool: false, service: true, kernel: true, init: null, pinned: false });
  expect(service.steps(need as MacNeed)).toEqual([
    { id: "service", size: null },
    { id: "kernel", size: null },
  ]);
  expect(runner.calls).toEqual([]);
});

test("a tool of another release that runs and has its kernel needs nothing, and the startup files are not asked for", async () => {
  const { service, runner } = looking([], true);
  expect(await service.need("running", "1.5.0")).toBeNull();
  expect(runner.calls).toEqual([]);
});

// Criterion: the install flow verifies the installer checksum before opening it, and refuses a mismatch with a message code.

test("a corrupted installer is refused with download.checksum_mismatch and nothing is opened", async () => {
  const corrupted = good.slice();
  corrupted[100] = (corrupted[100] ?? 0) ^ 0xff;
  files.files.set("/installer.pkg", corrupted);
  const { run, runner, steps } = setup([{ argv: openArgv(), result: OK }]);

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
        return OK;
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
    { argv: openArgv(), result: OK },
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
    { argv: openArgv(), result: OK },
    toolAppearsAfter(3),
    { argv: START, result: recorded("apple-container", "system-start") },
  ]);
  expect(await run()).toEqual({ ok: true });
  expect(runner.calls.filter((call) => call[0] === "open")).toEqual([openArgv()]);
  expect(runner.calls.filter((call) => call.join(" ") === VERSION.join(" "))).toHaveLength(4);
  expect(time.state.sleeps).toEqual([INSTALLER_POLL_MS, INSTALLER_POLL_MS, INSTALLER_POLL_MS]);
  expect(steps).toEqual(["installer", "approve", "service"]);
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
    { argv: openArgv(), result: OK },
    { argv: VERSION, result: () => answers[Math.min(asked++, answers.length - 1)] as { exitCode: number; stdout: string; stderr: string } },
    { argv: START, result: recorded("apple-container", "system-start") },
  ]);
  expect(await run()).toEqual({ ok: true });
  expect(runner.calls.filter((call) => call.join(" ") === VERSION.join(" "))).toHaveLength(5);
  expect(time.state.sleeps).toEqual([INSTALLER_POLL_MS, INSTALLER_POLL_MS, INSTALLER_POLL_MS, INSTALLER_POLL_MS]);
});

test("a container tool elsewhere on the search path is never run, so the wait ends in a timeout", async () => {
  const { run, runner } = setup([
    { argv: openArgv(), result: OK },
    { argv: ["container", "--version"], result: { exitCode: 0, stdout: VERSION_LINE, stderr: "" } },
    { argv: ["container", "system", "start", "--disable-kernel-install"], result: recorded("apple-container", "system-start") },
  ]);
  expect(await run()).toMatchObject({ ok: false, step: "approve", error: { data: { reason: "timeout" } } });
  expect(runner.calls.filter((call) => call[0] !== "open").every((call) => call[0] === TOOL)).toBe(true);
  expect(runner.calls.some((call) => call[0] === "container")).toBe(false);
});

test("a prompt nobody approves ends after 10 minutes with mac.install_not_finished", async () => {
  const { run, time, runner } = setup([{ argv: openArgv(), result: OK }]);
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
  const short = setup([{ argv: openArgv(), result: OK }], { waitMs: 5000, pollMs: 1000 });
  expect((await short.run()).ok).toBe(false);
  expect(short.time.state.sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);

  const abort = new AbortController();
  const cancelled = setup([{ argv: openArgv(), result: () => (abort.abort(), OK) }]);
  expect(await cancelled.run(TOOL_ONLY, abort.signal)).toEqual({
    ok: false,
    step: "approve",
    error: { code: "download.cancelled", data: {} },
  });
});

test("the operator can stop waiting for the approval: the step ends in mac.install_not_finished with the reason cancelled", async () => {
  const stop = new AbortController();
  const { run, runner } = setup([
    { argv: openArgv(), result: OK },
    { argv: VERSION, result: () => (stop.abort(), { exitCode: 127, stdout: "", stderr: "not found" }) },
  ]);
  expect(await run(TOOL_ONLY, undefined, stop.signal)).toEqual({
    ok: false,
    step: "approve",
    error: { code: "mac.install_not_finished", data: { reason: "cancelled" } },
  });
  expect(runner.calls.some((call) => call.includes("start"))).toBe(false);
});

test("stopping the wait does not wait for the next poll", async () => {
  const stop = new AbortController();
  // A sleep that never ends, as if the poll were an hour long: only the stop can end the wait.
  const { run } = setup([{ argv: openArgv(), result: OK }], {
    sleep: () => {
      stop.abort();
      return new Promise<void>(() => {});
    },
  });
  expect(await run(TOOL_ONLY, undefined, stop.signal)).toMatchObject({
    ok: false,
    error: { code: "mac.install_not_finished", data: { reason: "cancelled" } },
  });
});

// The system service.

test("the service of the release the pins are for starts with --disable-kernel-install, and never with --enable-kernel-install when a kernel is there", async () => {
  const { run, runner, steps } = setup([{ argv: START, result: recorded("apple-container", "system-start") }]);
  expect(await run(SERVICE_ONLY)).toEqual({ ok: true });
  expect(runner.calls).toEqual([START]);
  expect(steps).toEqual(["service"]);

  // Another release that already has its kernel is started the same way: it has nothing to download.
  const other = setup([{ argv: START, result: recorded("apple-container", "system-start") }]);
  expect(await other.run({ ...SERVICE_ONLY, pinned: false })).toEqual({ ok: true });
  expect(other.runner.calls).toEqual([START]);
  expect(other.steps).toEqual(["service"]);
});

test("a pinned release without a kernel still starts with --disable-kernel-install, because aidm-ui installs the kernel itself", async () => {
  const { run, runner } = setup(
    [
      { argv: START, result: recorded("apple-container", "system-start") },
      { argv: kernelSetArgv(), result: OK },
    ],
    { kernelPresent: () => false },
  );
  expect(await run({ ...SERVICE_ONLY, kernel: true })).toEqual({ ok: true });
  expect(runner.calls[0]).toEqual(START);
  expect(runner.calls.some((call) => call.includes("--enable-kernel-install"))).toBe(false);
});

test("another release without a kernel starts with --enable-kernel-install, on the kernel step, and its progress line reports the bytes received", async () => {
  const { run, runner, steps, received } = setup(
    [
      {
        argv: START_WITH_ITS_OWN_KERNEL,
        result: { exitCode: 0, stdout: "Launching container-apiserver...\nDownloading kernel 12% (80,0/664,3 MB, 1,0 MB/s) [1m 20s]\n", stderr: "" },
      },
    ],
    { kernelPresent: () => false },
  );
  expect(await run({ tool: false, service: true, kernel: true, init: null, pinned: false })).toEqual({ ok: true });
  expect(runner.calls).toEqual([START_WITH_ITS_OWN_KERNEL]);
  expect(steps).toEqual(["kernel"]);
  // 80 MiB, as the tool counts them.
  expect(received).toEqual([80 * 1024 * 1024]);
  // aidm-ui downloads nothing for a release it has no pins for.
  expect(files.requests).toEqual([]);
  expect(registry.requests).toEqual([]);
});

test("a failed start names the step it stopped in and its exit code, and the kernel is not downloaded after it", async () => {
  const { run, runner } = setup([{ argv: START, result: recorded("apple-container", "system-start-failed") }], { kernelPresent: () => false });
  expect(await run({ ...SERVICE_ONLY, kernel: true })).toEqual({
    ok: false,
    step: "service",
    error: { code: "mac.start_failed", data: { step: "service", exitCode: 1 } },
  });
  expect(runner.calls).toEqual([START]);
  expect(files.requests).toEqual([]);
});

test("a failed start of another release's own kernel download names the kernel step", async () => {
  const { run } = setup([{ argv: START_WITH_ITS_OWN_KERNEL, result: recorded("apple-container", "system-start-failed") }], { kernelPresent: () => false });
  expect(await run({ tool: false, service: true, kernel: true, init: null, pinned: false })).toEqual({
    ok: false,
    step: "kernel",
    error: { code: "mac.start_failed", data: { step: "kernel", exitCode: 1 } },
  });
});

// The kernel.

test("the kernel is downloaded, checked, and handed to the tool with exactly these arguments, and the archive is removed once the tool has it", async () => {
  let seen = "";
  const { run, runner, steps, received } = setup(
    [
      {
        argv: kernelSetArgv(),
        result: () => {
          // The tool gets the archive complete and checked, and the partial file is gone.
          seen = `${existsSync(`${kernelPath()}.part`)} ${sha256(readFileSync(kernelPath()))}`;
          return OK;
        },
      },
    ],
    { kernelPresent: () => false },
  );
  expect(await run(KERNEL_ONLY)).toEqual({ ok: true });
  expect(runner.calls).toEqual([
    [
      TOOL,
      "system",
      "kernel",
      "set",
      "--tar",
      kernelPath(),
      "--binary",
      "opt/kata/share/kata-containers/vmlinux-6.18.35-197-debug",
      "--digest",
      `sha256:${sha256(kernelBytes)}`,
    ],
  ]);
  expect(seen).toBe(`false ${sha256(kernelBytes)}`);
  expect(steps).toEqual(["kernel"]);
  expect(received.at(-1)).toBe(kernelBytes.length);
  // Unpacking 664 MiB takes a while, so the tool is given minutes.
  expect(runner.timeouts[0]).toBeGreaterThan(60_000);
  expect(existsSync(kernelPath())).toBe(false);
});

test("a corrupted kernel archive is refused with download.checksum_mismatch, the tool is never given it, and nothing is left behind", async () => {
  const corrupted = kernelBytes.slice();
  corrupted[1000] = (corrupted[1000] ?? 0) ^ 0xff;
  files.files.set("/kernel.tar.zst", corrupted);
  const { run, runner, steps } = setup([{ argv: kernelSetArgv(), result: OK }], { kernelPresent: () => false });

  expect(await run(KERNEL_ONLY)).toEqual({ ok: false, step: "kernel", error: { code: "download.checksum_mismatch", data: {} } });
  expect(runner.calls).toEqual([]);
  expect(steps).toEqual(["kernel"]);
  expect(existsSync(kernelPath())).toBe(false);
});

test("a kernel download that is cut goes on from the last byte, and the tool gets the whole archive", async () => {
  let seen = "";
  const { run } = setup(
    [
      {
        argv: kernelSetArgv(),
        result: () => {
          seen = sha256(readFileSync(kernelPath()));
          return OK;
        },
      },
    ],
    { kernelPresent: () => false },
  );
  files.cutNextResponseAfter(20_000);
  expect(await run(KERNEL_ONLY)).toEqual({ ok: true });

  const gets = files.requests.filter((request) => request.method === "GET" && request.path === "/kernel.tar.zst");
  expect(gets).toHaveLength(2);
  expect(gets[0]?.range).toBeNull();
  expect(gets[1]?.range).toMatch(/^bytes=[1-9]\d*-$/);
  expect(seen).toBe(sha256(kernelBytes));
});

test("a kernel the tool refuses is mac.kernel_failed with the exit code, the archive stays, and the next try does not download it again", async () => {
  let accept = false;
  const { run, runner, log } = setup(
    [{ argv: kernelSetArgv(), result: () => (accept ? OK : { exitCode: 1, stdout: "", stderr: "Error: the archive could not be unpacked\n" }) }],
    { kernelPresent: () => false },
  );
  expect(await run(KERNEL_ONLY)).toEqual({ ok: false, step: "kernel", error: { code: "mac.kernel_failed", data: { exitCode: 1 } } });
  expect(existsSync(kernelPath())).toBe(true);
  expect(sha256(readFileSync(kernelPath()))).toBe(kernelPin.sha256);
  // The reason the tool gave is in the log, not on the page.
  expect(log.some((line) => line.includes("the archive could not be unpacked"))).toBe(true);

  const requests = files.requests.length;
  accept = true;
  expect(await run(KERNEL_ONLY)).toEqual({ ok: true });
  expect(files.requests.length).toBe(requests);
  expect(runner.calls).toHaveLength(2);
  expect(existsSync(kernelPath())).toBe(false);
});

test("a kernel that is there is not downloaded and not given to the tool again", async () => {
  const { run, runner } = setup([{ argv: kernelSetArgv(), result: OK }], { kernelPresent: () => true });
  expect(await run({ ...KERNEL_ONLY, kernel: false })).toEqual({ ok: true });
  expect(runner.calls).toEqual([]);
  expect(files.requests).toEqual([]);
});

// The startup files.

test("startup files the tool already holds are not downloaded: the tool is asked by their name and that is all", async () => {
  const { rules } = startupFiles(true);
  const { run, runner, steps } = setup(rules);
  expect(await run(INIT_ONLY)).toEqual({ ok: true });
  expect(runner.calls).toEqual([INSPECT_INIT]);
  expect(steps).toEqual(["init"]);
  expect(files.requests).toEqual([]);
  expect(registry.requests).toEqual([]);
});

test("missing startup files are downloaded from the registry the pin names, checked blob by blob, loaded through standard input, and the download is removed", async () => {
  let atLoad = "";
  const { rules } = startupFiles(false, { onLoad: () => (atLoad = existsSync(join(initFolder(), "index.json")) ? "download in place" : "no download") });
  const { run, runner, steps, received } = setup(rules);
  expect(await run(INIT_ONLY)).toEqual({ ok: true });

  // Asked once, then loaded. The tool shows nothing of its startup files afterwards, so it is not asked again:
  // the load counts by its exit code and the name it printed, and the first container start is the last proof.
  expect(runner.calls).toEqual([INSPECT_INIT, LOAD]);
  expect(steps).toEqual(["init"]);
  expect(atLoad).toBe("download in place");
  expect(runner.inputs).toHaveLength(1);
  expect(runner.inputs[0]?.argv).toEqual(LOAD);
  expect(runner.inputs[0]?.bytes.length).toBeGreaterThan(initImage.size);
  expect(registry.requests.some((request) => request.path.endsWith(`/manifests/${initImage.digest}`))).toBe(true);
  expect(files.requests.some((request) => request.path === "/kernel.tar.zst")).toBe(false);
  expect(received.at(-1)).toBe(initImage.size);
  expect(existsSync(initFolder())).toBe(false);
});

test("startup files that are there answer inspect with an empty list, which counts as there, not as a wrong version", async () => {
  const { run, runner } = setup([{ argv: INSPECT_INIT, result: recorded("apple-container", "image-inspect-init-present") }]);
  expect(await run(INIT_ONLY)).toEqual({ ok: true });
  expect(runner.calls).toEqual([INSPECT_INIT]);
  expect(registry.requests).toEqual([]);
});

test("a load that names another image is mac.init_not_named, and the download stays", async () => {
  const { rules } = startupFiles(false, { named: "untagged@sha256:1234" });
  const { run, runner } = setup(rules);
  expect(await run(INIT_ONLY)).toEqual({ ok: false, step: "init", error: { code: "mac.init_not_named", data: {} } });
  expect(runner.calls).toEqual([INSPECT_INIT, LOAD]);
  expect(existsSync(initFolder())).toBe(true);
});

test("startup files the tool refuses to load are mac.init_load_failed with the exit code, and the download stays", async () => {
  const { run, runner } = setup([
    { argv: INSPECT_INIT, result: recorded("apple-container", "image-inspect-init-missing") },
    { argv: LOAD, result: { exitCode: 1, stdout: "", stderr: "Error: internalError\n" } },
  ]);
  expect(await run(INIT_ONLY)).toEqual({ ok: false, step: "init", error: { code: "mac.init_load_failed", data: { exitCode: 1 } } });
  expect(runner.calls).toEqual([INSPECT_INIT, LOAD]);
  expect(existsSync(initFolder())).toBe(true);
});

test("an inspect that neither finds nor misses the startup files is mac.init_check_failed, nothing is downloaded, and the log says what was expected and found", async () => {
  const { run, log: logs } = setup([{ argv: INSPECT_INIT, result: { exitCode: 1, stdout: "", stderr: "Error: internalError: XPC connection error\n" } }]);
  expect(await run(INIT_ONLY)).toEqual({ ok: false, step: "init", error: { code: "mac.init_check_failed", data: { exitCode: 1 } } });
  expect(registry.requests).toEqual([]);
  expect(logs).toContain(
    'Startup files check failed: expected exit 0 (there) or "image not found" (missing), found exit 1: Error: internalError: XPC connection error',
  );
});

// The whole way.

test("a Mac without the tool goes through the installer, the approval, the service, the kernel and the startup files, in that order", async () => {
  const { rules: init } = startupFiles(false);
  const { run, runner, steps } = setup(
    [
      { argv: openArgv(), result: OK },
      toolAppearsAfter(1),
      { argv: START, result: recorded("apple-container", "system-start") },
      { argv: kernelSetArgv(), result: OK },
      ...init,
    ],
    { kernelPresent: () => false },
  );
  expect(await run({ tool: true, service: true, kernel: true, init: "unknown", pinned: true })).toEqual({ ok: true });
  expect(steps).toEqual(["installer", "approve", "service", "kernel", "init"]);
  expect(runner.calls.filter((call) => call[1] !== "--version")).toEqual([
    openArgv(),
    START,
    kernelSetArgv(),
    INSPECT_INIT,
    LOAD,
  ]);
});
