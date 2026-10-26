import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { InstallStepView, LocalEngineView, MachineCheckView, RunView } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeRegistry } from "../../test-support/fake-registry.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { macInputs, recordedMachine, type MachineInputs } from "../../test-support/recorded-machine.ts";
import { ScriptedRunner, recorded, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { CONTAINER_NAME, containerConfigFolder } from "../packages/container-package.ts";
import { APPLE_CONTAINER_INIT_IMAGE, APPLE_CONTAINER_KERNEL, type InitImagePin, type InstallerPin, type KernelPin } from "../runtimes/apple-container-installer.ts";
import { SAMPLE_DATASET } from "../sample/sample-dataset.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

const GiB = 1024 ** 3;
const ENGINE_SIZE = 622_710_197;
/** The sizes of the real pins, for the tests that download nothing. */
const REAL_KERNEL_SIZE = 696_573_576;
const REAL_INIT_SIZE = 69_425_005;
/** Spelled out here on purpose: the tool is always called by this path. */
const TOOL = "/usr/local/bin/container";
const START = [TOOL, "system", "start", "--disable-kernel-install"];
const START_WITH_ITS_OWN_KERNEL = [TOOL, "system", "start", "--enable-kernel-install"];
/** The kernel archive sits in the harness's own data folder, so `kernel set` is matched with a stand-in for its path. */
const KERNEL_SET = [TOOL, "system", "kernel", "set", "--tar", "<kernel>", "--binary", APPLE_CONTAINER_KERNEL.member, "--digest", "<digest>"];
const INSPECT_INIT = [TOOL, "image", "inspect", APPLE_CONTAINER_INIT_IMAGE.reference];
const LOAD = [TOOL, "image", "load"];
const OK = { exitCode: 0, stdout: "", stderr: "" };
const NOT_FOUND = { exitCode: 1, stdout: "", stderr: "Error: notFound: image not found\n" };

const open: Harness[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
let scratch: string;
let files: FakeFileServer;
let registry: FakeRegistry;
let installer: Uint8Array;
let kernelBytes: Uint8Array;
let initSize: number;
let pin: InstallerPin;
let kernelPin: KernelPin;
let initPin: InitImagePin;

/** Deterministic bytes that differ from one seed to the next. */
function bytesOf(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + (i >> 8) * seed + seed) & 0xff);
}

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.stop();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await files.stop();
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  scratch = mkdtempSync(join(os.tmpdir(), "aidm-ui-mac-install-"));
  installer = new Uint8Array(30_000).map((_, index) => (index * 13) % 251);
  kernelBytes = bytesOf(50_000, 11);
  registry = new FakeRegistry();
  files = new FakeFileServer({ "/installer.pkg": installer, "/kernel.tar.zst": kernelBytes });
  files.registry = registry;
  await files.start();
  const added = registry.addImage({
    repository: "apple/containerization/vminit",
    config: bytesOf(1500, 3),
    layers: [bytesOf(30_000, 5), bytesOf(20_000, 7)],
  });
  initSize = added.size;
  pin = {
    version: "1.6.1",
    url: files.url("/installer.pkg"),
    size: installer.length,
    sha256: new Bun.CryptoHasher("sha256").update(installer).digest("hex"),
  };
  kernelPin = {
    ...APPLE_CONTAINER_KERNEL,
    url: files.url("/kernel.tar.zst"),
    size: kernelBytes.length,
    sha256: new Bun.CryptoHasher("sha256").update(kernelBytes).digest("hex"),
  };
  initPin = {
    ...APPLE_CONTAINER_INIT_IMAGE,
    repository: `${new URL(files.url("/")).host}/apple/containerization/vminit`,
    digest: added.digest,
    size: added.size,
  };
});

/** The package sits in the harness's own data folder, so `open` is matched by its program and the path is left out. */
class MacRunner extends ScriptedRunner {
  /** Runs just before the system start, for a test that needs something to happen around it. */
  beforeStart: (() => Promise<void>) | undefined;
  /** The `kernel set` calls as they were made, with the real path and digest. */
  readonly kernelSets: string[][] = [];

  override run(argv: string[], options?: Parameters<ScriptedRunner["run"]>[1]) {
    if (argv[0] === "open") return super.run(["open", "<installer>"], options);
    // The kernel archive and its digest are the pins of the test, so only the shape of the call is matched.
    const tar = argv.indexOf("--tar");
    const digest = argv.indexOf("--digest");
    if (argv.includes("kernel") && tar !== -1 && digest !== -1) {
      this.kernelSets.push(argv);
      const standIn = argv.slice();
      standIn[tar + 1] = "<kernel>";
      standIn[digest + 1] = "<digest>";
      return super.run(standIn, options);
    }
    return super.run(argv, options);
  }

  override async stream(argv: string[], options: Parameters<ScriptedRunner["stream"]>[1]) {
    if (argv.join(" ") === START.join(" ")) await this.beforeStart?.();
    return super.stream(argv, options);
  }
}

const MAC = { platform: "darwin", arch: "arm64", totalMemory: 32 * GiB, cpuCount: 8 } as const;

/** The fake Apple runtime and what the scripted runner needs to make it appear. */
function appleFake(state: "missing" | "stopped" | "running", version = "1.6.1"): FakeRuntime {
  const detection =
    state === "running"
      ? { version }
      : {
          available: false,
          version: state === "stopped" ? version : null,
          problem:
            state === "stopped"
              ? { code: "runtime.apple_not_started" as const, data: {} }
              : { code: "runtime.not_installed" as const, data: { runtime: "apple-container" } },
        };
  return new FakeRuntime({ id: "apple-container", detection });
}

interface Mac {
  h: Harness;
  runner: MacRunner;
  apple: FakeRuntime;
  clock: { now: number };
}

/**
 * A Mac. The commands the install runs are answered from recordings; the tool
 * "appears" once the package was opened and two polls have passed, and the
 * system start makes the fake runtime work. A Mac whose tool was there before
 * has its kernel and its startup files, unless a test says it has not. The
 * kernel is installed by the tool's `kernel set`, and the startup files by
 * its `image load`, which the scripted tool answers like the real one.
 */
function mac(
  state: "missing" | "stopped" | "running",
  options: {
    inputs?: MachineInputs;
    localMachine?: NonNullable<Parameters<typeof openHarness>[0]>["localMachine"];
    start?: ScriptedRule["result"];
    open?: ScriptedRule["result"];
    /** The release the tool reports. */
    toolVersion?: string;
    /** Whether the kernel is installed before the install starts. */
    kernel?: boolean;
    /** Whether the tool holds the startup files before the install starts. */
    init?: boolean;
    kernelSet?: ScriptedRule["result"];
    /** The tool's answer to loading the startup files. */
    load?: ScriptedRule["result"];
    appears?: boolean;
    /** Replaces the wait between two polls, which by default only moves the clock. */
    sleep?: (ms: number) => Promise<void>;
    beforeStart?: () => Promise<void>;
    sampleDataset?: NonNullable<Parameters<typeof openHarness>[0]>["sampleDataset"];
  } = {},
): Mac {
  const toolVersion = options.toolVersion ?? "1.6.1";
  const apple = appleFake(state, toolVersion);
  const clock = { now: 1_000_000 };
  let opened = false;
  let polls = 0;
  let kernelThere = options.kernel ?? state !== "missing";
  const startupFilesThere = options.init ?? state !== "missing";
  let startupFilesLoaded = false;
  const ready = () => {
    apple.detection = { ...apple.detection, available: true, version: toolVersion, problem: null };
  };
  const startResult = options.start ?? recorded("apple-container", "system-start");
  const rules: ScriptedRule[] = [
    {
      argv: ["open", "<installer>"],
      result: () => {
        opened = true;
        return typeof options.open === "function" ? options.open(["open"]) : (options.open ?? { exitCode: 0, stdout: "", stderr: "" });
      },
    },
    {
      argv: [TOOL, "--version"],
      result: () =>
        opened && options.appears !== false && ++polls > 2
          ? { exitCode: 0, stdout: `container CLI version ${toolVersion} (build: release, commit: 804209b)\n`, stderr: "" }
          : { exitCode: 127, stdout: "", stderr: "not found" },
    },
    ...[START, START_WITH_ITS_OWN_KERNEL].map(
      (argv): ScriptedRule => ({
        argv,
        result: async (called) => {
          const result = typeof startResult === "function" ? await startResult(called) : startResult;
          if (result.exitCode === 0) {
            ready();
            // A tool that downloads its own kernel has it once it started.
            if (argv === START_WITH_ITS_OWN_KERNEL) kernelThere = true;
          }
          return result;
        },
      }),
    ),
    {
      argv: KERNEL_SET,
      result: async (called) => {
        const result = options.kernelSet === undefined ? OK : typeof options.kernelSet === "function" ? await options.kernelSet(called) : options.kernelSet;
        if (result.exitCode === 0) kernelThere = true;
        return result;
      },
    },
    {
      argv: INSPECT_INIT,
      result: () =>
        // The tool hides its startup files from inspect: present is exit 0 with an empty list (recorded on a real Mac).
        startupFilesThere || startupFilesLoaded ? recorded("apple-container", "image-inspect-init-present") : recorded("apple-container", "image-inspect-init-missing"),
    },
    {
      argv: LOAD,
      result: async (called) => {
        // A load prints the reference it loaded (recorded on a real Mac).
        const result = options.load === undefined ? recorded("apple-container", "image-load-init") : typeof options.load === "function" ? await options.load(called) : options.load;
        if (result.exitCode === 0) startupFilesLoaded = true;
        return result;
      },
    },
  ];
  const runner = new MacRunner(rules);
  runner.beforeStart = options.beforeStart;
  const h = openHarness({
    enginePollMs: 50,
    runPollMs: 30,
    localMachine: options.localMachine ?? MAC,
    runtimes: { "apple-container": apple },
    machine: recordedMachine(options.inputs ?? macInputs("26")),
    sampleDataset: options.sampleDataset,
    macSetup: {
      runner,
      installer: pin,
      kernel: kernelPin,
      initImage: initPin,
      kernelPresent: () => kernelThere,
      sleep:
        options.sleep ??
        (async (ms) => {
          clock.now += ms;
        }),
      now: () => clock.now,
      backoffMs: () => 0,
    },
  });
  open.push(h);
  return { h, runner, apple, clock };
}

const send = (h: Harness, method: string, path: string) => fetch(`${h.base}${path}`, { method });
const localView = async (h: Harness) => (await (await send(h, "GET", "/api/local-engine")).json()) as LocalEngineView;
const errorOf = async (response: Response) => ((await response.json()) as { error: ApiError }).error;
const ids = (steps: InstallStepView[]) => steps.map((step) => step.id);

/** Reads the server-sent views of the local engine as they arrive. */
function watch(h: Harness) {
  const views: LocalEngineView[] = [];
  const abort = new AbortController();
  const done = (async () => {
    const response = await fetch(`${h.base}/api/local-engine/events`, { signal: abort.signal });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value);
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const data = buffer.slice(0, end).split("\n").find((line) => line.startsWith("data: "));
          buffer = buffer.slice(end + 2);
          if (data !== undefined) views.push(JSON.parse(data.slice(6)) as LocalEngineView);
        }
      }
    } catch {
      // Aborted below.
    }
  })();
  cleanups.push(async () => {
    abort.abort();
    await done;
  });
  return views;
}

// Criterion: on recorded inputs for an Intel Mac or macOS 15, the wizard does not offer the local engine and offers a remote engine.

for (const [name, inputs, localMachine, code] of [
  ["an Intel Mac", macInputs("26", { arch: "x64" }), { ...MAC, arch: "x64" }, "machine.mac_intel"],
  ["macOS 15", macInputs("15"), MAC, "machine.macos_too_old"],
] as const) {
  test(`on ${name} the machine check does not offer the local engine, and the install route refuses with the check's reason`, async () => {
    const { h, runner } = mac("missing", { inputs, localMachine });

    const check = (await (await send(h, "GET", "/api/machine-check")).json()) as MachineCheckView;
    expect(check.localEngine.offered).toBe(false);
    expect(check.localEngine.reason?.code).toBe(code);

    const response = await send(h, "POST", "/api/local-engine/install");
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe(code);
    // Nothing was downloaded or opened, and no engine was added.
    expect(files.requests).toEqual([]);
    expect(runner.calls).toEqual([]);
    expect((await localView(h)).install).toBeNull();
    // The way to a remote engine stays: adding one needs no local engine.
    expect((await send(h, "GET", "/api/engines")).status).toBe(200);
  });
}

// Criterion: the wizard shows the kernel and init steps with sizes before the engine download.

test("before any click the view already holds the plan of what the Mac lacks, and nothing for a Mac that lacks nothing", async () => {
  const missing = mac("missing");
  expect((await localView(missing.h)).plan).toEqual([
    { id: "installer", size: pin.size },
    { id: "approve", size: null },
    { id: "service", size: null },
    { id: "kernel", size: kernelBytes.length },
    { id: "init", size: initSize },
    { id: "engine", size: ENGINE_SIZE },
  ]);
  // A tool that was there before, with its kernel, only needs its service started and its startup files looked for.
  expect((await localView(mac("stopped").h)).plan).toEqual([
    { id: "service", size: null },
    { id: "init", size: initSize },
    { id: "engine", size: ENGINE_SIZE },
  ]);
  // A tool of another release fetches a kernel of its own, whose size is not known.
  expect((await localView(mac("stopped", { toolVersion: "1.5.0", kernel: false }).h)).plan).toEqual([
    { id: "service", size: null },
    { id: "kernel", size: null },
    { id: "engine", size: ENGINE_SIZE },
  ]);
  const running = mac("running");
  expect((await localView(running.h)).plan).toBeNull();
  // At most the tool was asked whether it holds the startup files.
  expect(running.runner.calls.every((call) => call.join(" ") === INSPECT_INIT.join(" "))).toBe(true);
});

test("the step list is complete, with the sizes of the downloads, before the first step starts", async () => {
  const { h } = mac("missing");
  const views = watch(h);
  await eventually(async () => views.length > 0);

  const response = await send(h, "POST", "/api/local-engine/install");
  expect(response.status).toBe(202);
  const accepted = (await response.json()) as LocalEngineView;
  expect(accepted.install?.steps).toEqual([
    { id: "installer", size: pin.size },
    { id: "approve", size: null },
    { id: "service", size: null },
    { id: "kernel", size: kernelBytes.length },
    { id: "init", size: initSize },
    { id: "engine", size: ENGINE_SIZE },
  ]);
  // The first picture of the install is already complete and has not moved past the first step.
  expect(accepted.install).toMatchObject({ phase: "preparing", step: "installer" });

  await eventually(async () => (await localView(h)).state === "ready");
  const installViews = views.filter((view) => view.install !== null).map((view) => view.install);
  for (const install of installViews) expect(ids(install?.steps ?? [])).toEqual(["installer", "approve", "service", "kernel", "init", "engine"]);
  // The steps came in order, and the engine's download came last.
  const seen = installViews.map((install) => install?.step).filter((step, index, all) => step !== all[index - 1]);
  expect(seen).toEqual(["installer", "approve", "service", "kernel", "init", "engine"]);
  const firstEngine = installViews.findIndex((install) => install?.step === "engine");
  expect(installViews.slice(0, firstEngine).every((install) => install?.phase === "preparing")).toBe(true);
  expect(installViews[firstEngine]?.phase).toBe("pulling");
  // The progress of each download was reported in bytes, against the size of its own step.
  expect(installViews.some((install) => install?.step === "installer" && install.stepReceived === pin.size)).toBe(true);
  expect(installViews.some((install) => install?.step === "kernel" && install.stepReceived === kernelBytes.length)).toBe(true);
  expect(installViews.some((install) => install?.step === "init" && install.stepReceived === initSize)).toBe(true);
});

test("a Mac without the tool installs it, starts its service, sets the kernel from the checked download and loads the startup files, without the force flag", async () => {
  const { h, runner } = mac("missing");
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");

  // The look at the startup files comes before and after the load, and the manager may look again later, so the looks are left out here.
  const commands = runner.calls.map((call) => call.join(" ")).filter((call) => !call.endsWith("--version") && call !== INSPECT_INIT.join(" "));
  expect(commands).toEqual(["open <installer>", START.join(" "), KERNEL_SET.join(" "), LOAD.join(" ")]);
  expect(runner.calls.filter((call) => call.join(" ") === INSPECT_INIT.join(" ")).length).toBeGreaterThanOrEqual(2);
  // The tool was given the archive in the downloads folder, with the member and the digest of the pin.
  const archive = join(h.dataFolder, "downloads", "kata-static-3.32.0-arm64.tar.zst");
  expect(runner.kernelSets).toEqual([
    [TOOL, "system", "kernel", "set", "--tar", archive, "--binary", APPLE_CONTAINER_KERNEL.member, "--digest", `sha256:${kernelPin.sha256}`],
  ]);
  for (const forbidden of ["--force", "system stop", "image delete", "uninstall", "--enable-kernel-install"]) {
    expect(commands.filter((command) => command.includes(forbidden))).toEqual([]);
  }
  // The kernel archive is gone once the tool has it.
  expect(existsSync(archive)).toBe(false);
});

test("a Mac whose service is stopped, with its kernel and its startup files, shows the service, the startup files and the engine, and downloads nothing", async () => {
  const { h, runner } = mac("stopped");
  const accepted = (await (await send(h, "POST", "/api/local-engine/install")).json()) as LocalEngineView;
  expect(accepted.install?.steps).toEqual([
    { id: "service", size: null },
    { id: "init", size: initSize },
    { id: "engine", size: ENGINE_SIZE },
  ]);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(files.requests).toEqual([]);
  expect(runner.calls.some((call) => call[0] === "open")).toBe(false);
  expect(runner.calls.some((call) => call.includes("kernel") || call.includes("load"))).toBe(false);
  expect(runner.calls).toContainEqual(START);
});

test("a Mac whose service is stopped and whose tool lacks the startup files downloads and loads them, and not the kernel", async () => {
  const { h, runner } = mac("stopped", { init: false });
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(runner.calls.filter((call) => call.join(" ") === LOAD.join(" "))).toHaveLength(1);
  expect(registry.requests.length).toBeGreaterThan(0);
  expect(files.requests.some((request) => request.path === "/kernel.tar.zst")).toBe(false);
  expect(runner.calls.some((call) => call.includes("kernel"))).toBe(false);
});

test("a Mac whose tool is another release and has no kernel starts it with its own kernel download, and downloads nothing itself", async () => {
  const { h, runner } = mac("stopped", { toolVersion: "1.5.0", kernel: false });
  const accepted = (await (await send(h, "POST", "/api/local-engine/install")).json()) as LocalEngineView;
  expect(accepted.install?.steps).toEqual([
    { id: "service", size: null },
    { id: "kernel", size: null },
    { id: "engine", size: ENGINE_SIZE },
  ]);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(runner.calls).toContainEqual(START_WITH_ITS_OWN_KERNEL);
  expect(runner.calls).not.toContainEqual(START);
  expect(runner.calls.some((call) => call.includes("set"))).toBe(false);
  expect(files.requests).toEqual([]);
  expect(registry.requests).toEqual([]);
});

test("a Mac with the tool running but without a kernel gets the kernel set and nothing else of the tool", async () => {
  const { h, runner } = mac("running", { kernel: false });
  const accepted = (await (await send(h, "POST", "/api/local-engine/install")).json()) as LocalEngineView;
  expect(accepted.install?.steps).toEqual([
    { id: "kernel", size: kernelBytes.length },
    { id: "engine", size: ENGINE_SIZE },
  ]);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(runner.calls.some((call) => call.includes("start"))).toBe(false);
  expect(runner.calls.some((call) => call[0] === "open")).toBe(false);
  expect(runner.calls.filter((call) => call.includes("kernel"))).toHaveLength(1);
  expect(files.requests.filter((request) => request.path === "/kernel.tar.zst").length).toBeGreaterThan(0);
});

test("a Mac with the tool running but without the startup files gets them loaded and nothing else of the tool", async () => {
  const { h, runner } = mac("running", { init: false });
  const accepted = (await (await send(h, "POST", "/api/local-engine/install")).json()) as LocalEngineView;
  expect(accepted.install?.steps).toEqual([
    { id: "init", size: initSize },
    { id: "engine", size: ENGINE_SIZE },
  ]);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(runner.calls.some((call) => call.includes("start"))).toBe(false);
  expect(runner.calls.filter((call) => call.join(" ") === LOAD.join(" "))).toHaveLength(1);
  expect(registry.requests.length).toBeGreaterThan(0);
  expect(files.requests.some((request) => request.path === "/kernel.tar.zst" || request.path === "/installer.pkg")).toBe(false);
});

test("a Mac that already has the tool running with its kernel and startup files installs the engine alone, as any other computer does", async () => {
  const { h, runner } = mac("running");
  const accepted = (await (await send(h, "POST", "/api/local-engine/install")).json()) as LocalEngineView;
  expect(accepted.install?.steps).toEqual([{ id: "engine", size: ENGINE_SIZE }]);
  await eventually(async () => (await localView(h)).state === "ready");
  // The tool was asked whether it holds the startup files, and nothing else was run.
  expect(runner.calls.every((call) => call.join(" ") === INSPECT_INIT.join(" "))).toBe(true);
  expect(files.requests).toEqual([]);
  expect((await localView(h)).installed).toMatchObject({ runtime: "apple-container", variant: "linux-arm64-cpu" });
});

// Criterion: the install flow verifies the installer checksum before opening it.

test("a corrupted installer stops the install at its step with download.checksum_mismatch, and nothing is opened", async () => {
  files.files.set("/installer.pkg", installer.map((byte, index) => (index === 5 ? byte ^ 1 : byte)));
  const { h, runner } = mac("missing");
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "failed");

  const view = await localView(h);
  expect(view.problem).toEqual({ code: "download.checksum_mismatch", data: {} });
  expect(view.install).toMatchObject({ phase: "failed", step: "installer" });
  expect(runner.calls.some((call) => call[0] === "open")).toBe(false);
  expect(view.installed).toBeNull();
  // A second try, once the file is right, goes through from the start.
  files.files.set("/installer.pkg", installer);
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");
});

// Failure paths end in a message code on the page, which offers the remote engine.

test("a prompt nobody approves ends in mac.install_not_finished at the approval step", async () => {
  const { h, runner } = mac("missing", { appears: false });
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "failed");
  const view = await localView(h);
  expect(view.problem).toEqual({ code: "mac.install_not_finished", data: { reason: "timeout" } });
  expect(view.install).toMatchObject({ phase: "failed", step: "approve" });
  expect(runner.calls.some((call) => call.includes("system"))).toBe(false);
  expect(view.installed).toBeNull();
});

test("a system start that fails ends in mac.start_failed at the service step, and the kernel is not downloaded after it", async () => {
  const { h, runner } = mac("missing", { start: recorded("apple-container", "system-start-failed") });
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "failed");
  const view = await localView(h);
  expect(view.problem).toEqual({ code: "mac.start_failed", data: { step: "service", exitCode: 1 } });
  expect(view.install).toMatchObject({ phase: "failed", step: "service" });
  expect(files.requests.some((request) => request.path === "/kernel.tar.zst")).toBe(false);
  expect(runner.kernelSets).toEqual([]);
});

test("a kernel the tool refuses ends in mac.kernel_failed at the kernel step, keeps the download, and a second try goes through", async () => {
  let refuse = true;
  const { h, runner } = mac("missing", { kernelSet: () => (refuse ? { exitCode: 1, stdout: "", stderr: "Error: the archive could not be unpacked\n" } : OK) });
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "failed");
  const view = await localView(h);
  expect(view.problem).toEqual({ code: "mac.kernel_failed", data: { exitCode: 1 } });
  expect(view.install).toMatchObject({ phase: "failed", step: "kernel" });
  const archive = join(h.dataFolder, "downloads", "kata-static-3.32.0-arm64.tar.zst");
  expect(existsSync(archive)).toBe(true);
  expect(runner.calls.some((call) => call.join(" ") === LOAD.join(" "))).toBe(false);

  // The tool is installed and its service runs now, so the second try only sets the kernel and loads the startup files.
  refuse = false;
  const kernelRequests = () => files.requests.filter((request) => request.path === "/kernel.tar.zst").length;
  const before = kernelRequests();
  expect(before).toBeGreaterThan(0);
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(kernelRequests()).toBe(before);
  expect(runner.kernelSets).toHaveLength(2);
  expect(existsSync(archive)).toBe(false);
});

test("startup files the tool cannot load end in mac.init_load_failed at the init step", async () => {
  const { h } = mac("stopped", { init: false, load: { exitCode: 1, stdout: "", stderr: "Error: internalError\n" } });
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "failed");
  const view = await localView(h);
  expect(view.problem).toEqual({ code: "mac.init_load_failed", data: { exitCode: 1 } });
  expect(view.install).toMatchObject({ phase: "failed", step: "init" });
});

test("a start that reports success while the tool still does not answer is a failed start, not a hang", async () => {
  const { h, apple } = mac("missing");
  // The fake never becomes available.
  const original = apple.detect.bind(apple);
  apple.detect = async () => ({ ...(await original()), available: false });
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "failed");
  expect((await localView(h)).problem?.code).toBe("mac.start_failed");
});

/** What the install asks the disk for when the installer, the kernel and the startup files add `before` bytes to the data folder. */
function diskNeeded(before: number): number {
  // One disk holds it all: the engine's download, the downloads of the Mac steps in the data folder, and the
  // runtime's copy and the unpacked layers next to them (the fake runtime makes one copy).
  const extra = Math.ceil(before * 1.2);
  return Math.ceil(ENGINE_SIZE + 0.2 * ENGINE_SIZE + extra + Math.ceil((1 + 2.8) * ENGINE_SIZE + 0.2 * ENGINE_SIZE));
}

// The pins are the real ones here: nothing is downloaded, so only their sizes count. The installer is claimed to be big.
const BIG_INSTALLER = 3 * GiB;
for (const [name, state, kernelThere, toolVersion, listed, before] of [
  ["the installer, the kernel and the startup files for a Mac without the tool", "missing", false, "1.6.1", "unknown", BIG_INSTALLER + REAL_KERNEL_SIZE + REAL_INIT_SIZE],
  ["the kernel and the startup files for a Mac whose service is stopped and that has no kernel", "stopped", false, "1.6.1", "unknown", REAL_KERNEL_SIZE + REAL_INIT_SIZE],
  ["only the startup files for a Mac whose service is stopped and that has its kernel", "stopped", true, "1.6.1", "unknown", REAL_INIT_SIZE],
  ["only the startup files for a Mac whose tool runs, has its kernel and lacks them", "running", true, "1.6.1", "missing", REAL_INIT_SIZE],
  ["nothing of the kernel for a tool of another release, whose kernel has no known size", "stopped", false, "1.5.0", "none", 0],
] as const) {
  test(`without enough disk the install refuses before downloading anything, counting ${name}`, async () => {
    // Room for one byte less than it needs.
    const free = diskNeeded(before) - 1;
    // A tool that runs is asked whether it holds the startup files.
    const runner = new ScriptedRunner(listed === "missing" ? [{ argv: INSPECT_INIT, result: NOT_FOUND }] : []);
    const small = openHarness({
      enginePollMs: 50,
      localMachine: MAC,
      runtimes: { "apple-container": appleFake(state, toolVersion) },
      machine: recordedMachine(macInputs("26")),
      freeBytes: () => free,
      macSetup: { runner, installer: { ...pin, size: BIG_INSTALLER }, kernelPresent: () => kernelThere },
    });
    open.push(small);
    const response = await send(small, "POST", "/api/local-engine/install");
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toEqual({ code: "install.not_enough_space", data: { needed: diskNeeded(before), free } });
    expect(files.requests).toEqual([]);
    // Only the look at the startup files, and only on a tool that runs.
    expect(runner.calls.every((call) => call.join(" ") === INSPECT_INIT.join(" "))).toBe(true);
  });
}

// The wait for the approval can be ended by the operator.

/** A wait between polls that really waits a moment and does not move the clock, so the 10 minutes never run out in a test. */
const holdOn = (): Promise<void> => Bun.sleep(5);
const cancelWaiting = (h: Harness) => send(h, "POST", "/api/local-engine/install/cancel");

test("while the page waits for the password, Stop waiting ends the step with mac.install_not_finished and the reason cancelled", async () => {
  const { h, runner } = mac("missing", { appears: false, sleep: holdOn });
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).install?.step === "approve");

  const response = await cancelWaiting(h);
  expect(response.status).toBe(200);
  await eventually(async () => (await localView(h)).state === "failed");

  const view = await localView(h);
  expect(view.problem).toEqual({ code: "mac.install_not_finished", data: { reason: "cancelled" } });
  expect(view.install).toMatchObject({ phase: "failed", step: "approve" });
  expect(view.installed).toBeNull();
  // Nothing after the approval ran, and a new try is allowed.
  expect(runner.calls.some((call) => call.includes("system"))).toBe(false);
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
});

test("Stop waiting when nothing waits for an approval changes nothing", async () => {
  const idle = mac("missing");
  const answer = await cancelWaiting(idle.h);
  expect(answer.status).toBe(200);
  expect((await answer.json() as LocalEngineView).install).toBeNull();
  expect(idle.runner.calls).toEqual([]);

  // A click that comes after the approval does not stop the later steps.
  const { h } = mac("missing");
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");
  expect((await cancelWaiting(h)).status).toBe(200);
  expect((await localView(h)).state).toBe("ready");
});

// The look at the tool after the system service started.

test("the engine is downloaded after a look at the tool that began after the service started, not one that began before it", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let late: Promise<Response> | undefined;
  const { h, apple } = mac("stopped", {
    beforeStart: async () => {
      // A look at the tools begins while the service is still off, and it ends after the service started.
      const original = apple.detect.bind(apple);
      let entered = (): void => {};
      const seen = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let held = false;
      apple.detect = async () => {
        const snapshot = await original();
        if (!held) {
          held = true;
          entered();
          await gate;
        }
        return snapshot;
      };
      late = fetch(`${h.base}/api/settings/runtime`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runtime: null }),
      });
      await seen;
      setTimeout(release, 50);
    },
  });
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(apple.loads).toHaveLength(1);
  await late;
});

test("a look at the tool that fails after the start is a failed start with a line of its own in the log", async () => {
  const { h, apple } = mac("stopped", {
    beforeStart: async () => {
      apple.detect = async () => {
        throw new Error("the tool did not answer");
      };
    },
  });
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "failed");
  expect((await localView(h)).problem?.code).toBe("mac.start_failed");
  expect(apple.loads).toEqual([]);
  expect(h.logs.some((line) => line.startsWith("Looking for container runtimes failed: the tool did not answer"))).toBe(true);
  expect(h.logs.some((line) => line.includes("could not be looked at again after it started"))).toBe(true);
});

test("a failure while working out the install steps is logged as that, and not as a failed look at the runtimes", async () => {
  const { h } = mac("stopped");
  h.manifests.offerWithVariant = async () => {
    throw new Error("the manifest broke");
  };
  await localView(h);
  expect(h.logs.some((line) => line.includes("Working out the install steps failed: the manifest broke"))).toBe(true);
  expect(h.logs.some((line) => line.startsWith("Looking for container runtimes failed"))).toBe(false);
});

// Criterion: the recorded start command always carries the memory and CPU flags and the rest, and never the token.

test("the container starts with the caps, the loopback publish, the bind mounts and the fixed name, and no token, no restart flag and no platform flag", async () => {
  const { h, apple } = mac("missing");
  await send(h, "POST", "/api/local-engine/install");
  await eventually(async () => (await localView(h)).state === "ready");

  const [started] = apple.starts;
  const argv = started?.argv ?? [];
  expect(argv.slice(0, 4)).toEqual([TOOL, "run", "-d", "--name"]);
  expect(argv[argv.indexOf("--name") + 1]).toBe(CONTAINER_NAME);
  expect(argv).not.toContain("--platform");
  expect(argv).toContain("--memory");
  expect(argv).toContain("--cpus");
  expect(argv[argv.indexOf("-p") + 1]).toMatch(/^127\.0\.0\.1:\d+:3000$/);
  expect(argv[argv.indexOf("-v") + 1]).toBe(`${join(h.dataFolder, "engine-data")}:/var/www/data`);
  expect(argv).toContain(`${containerConfigFolder(h.dataFolder)}:/etc/aidm-ui:ro`);
  expect(argv.slice(-2)).toEqual(["--config", "/etc/aidm-ui/task-api.json"]);
  const token = h.engineStore.local()?.token ?? "";
  expect(token).not.toBe("");
  expect(argv.join(" ")).not.toContain(token);
  expect(argv.some((part) => part.startsWith("--restart"))).toBe(false);
});

// Criterion: the sample job completes on the Mac path end to end with the fake runtime and the fake task API.

test("the sample job completes on the Mac path, from the first click on a Mac without the tool", async () => {
  const encoder = new TextEncoder();
  const zipPath = join(scratch, "dataset.zip");
  writeStoredZip(zipPath, [
    { name: "DJI_0001.JPG", data: encoder.encode("image one ".repeat(10)) },
    { name: "DJI_0002.JPG", data: encoder.encode("image two ".repeat(12)) },
  ]);
  const zip = new Uint8Array(readFileSync(zipPath));
  files.files.set("/dataset.zip", zip);
  const { h, apple } = mac("missing", {
    sampleDataset: {
      ...SAMPLE_DATASET,
      url: files.url("/dataset.zip"),
      size: zip.length,
      sha256: new Bun.CryptoHasher("sha256").update(zip).digest("hex"),
      imageCount: 2,
      fileName: "dataset.zip",
    },
  });

  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");
  const ready = await localView(h);
  expect(ready.installed).toMatchObject({ runtime: "apple-container", variant: "linux-arm64-cpu", kind: "container" });
  expect(ready.install).toMatchObject({ phase: "done", step: "engine" });

  const started = await fetch(`${h.base}/api/sample/start`, { method: "POST", body: JSON.stringify({ engineId: ready.engineId }) });
  expect(started.status).toBe(202);
  const run = (await started.json()) as RunView;
  const engine = apple.engine(CONTAINER_NAME);
  if (engine === undefined) throw new Error("The fake runtime has no engine.");

  await eventually(async () => engine.tasks.size === 1 && [...engine.tasks.values()][0]?.committed === true);
  const [uuid] = [...engine.tasks.keys()] as [string];
  expect(engine.uploads.map((upload) => upload.fileName)).toEqual(["DJI_0001.JPG", "DJI_0002.JPG"]);
  engine.setTask(uuid, { statusCode: 20, processingTime: 2000, progress: 40 });
  const results = new Uint8Array([80, 75, 3, 4, 9, 9, 9]);
  engine.setTask(uuid, { statusCode: 40, processingTime: 9000, progress: 100, results });
  const read = async () => (await (await send(h, "GET", `/api/runs/${run.id}`)).json()) as RunView;
  await eventually(async () => (await read()).state === "completed");
  expect(await read()).toMatchObject({ engineName: "This computer", engineLocal: true });
  const download = await send(h, "GET", `/api/runs/${run.id}/results`);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(results);
  expect(existsSync(join(h.dataFolder, "downloads", "container-1.6.1-installer-signed.pkg"))).toBe(true);
});
