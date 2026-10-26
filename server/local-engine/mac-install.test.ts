import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { InstallStepView, LocalEngineView, MachineCheckView, RunView } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { macInputs, recordedMachine, type MachineInputs } from "../../test-support/recorded-machine.ts";
import { ScriptedRunner, recorded, type ScriptedRule } from "../../test-support/scripted-runner.ts";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { CONTAINER_NAME } from "../packages/container-package.ts";
import type { InstallerPin } from "../runtimes/apple-container-installer.ts";
import { SAMPLE_DATASET } from "../sample/sample-dataset.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

const GiB = 1024 ** 3;
const ENGINE_SIZE = 622_710_197;
const KERNEL_SIZE = 696_573_576;
const START = ["container", "system", "start", "--enable-kernel-install"];

const open: Harness[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
let scratch: string;
let files: FakeFileServer;
let installer: Uint8Array;
let pin: InstallerPin;

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.stop();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await files.stop();
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  scratch = mkdtempSync(join(os.tmpdir(), "aidm-ui-mac-install-"));
  installer = new Uint8Array(30_000).map((_, index) => (index * 13) % 251);
  files = new FakeFileServer({ "/installer.pkg": installer });
  await files.start();
  pin = {
    version: "1.6.1",
    url: files.url("/installer.pkg"),
    size: installer.length,
    sha256: new Bun.CryptoHasher("sha256").update(installer).digest("hex"),
  };
});

/** The package sits in the harness's own data folder, so `open` is matched by its program and the path is left out. */
class MacRunner extends ScriptedRunner {
  override run(argv: string[]) {
    return super.run(argv[0] === "open" ? ["open", "<installer>"] : argv);
  }
}

const MAC = { platform: "darwin", arch: "arm64", totalMemory: 32 * GiB, cpuCount: 8 } as const;

/** The fake Apple runtime and what the scripted runner needs to make it appear. */
function appleFake(state: "missing" | "stopped" | "running"): FakeRuntime {
  const detection =
    state === "running"
      ? {}
      : {
          available: false,
          version: state === "stopped" ? "1.6.1" : null,
          problem:
            state === "stopped"
              ? { code: "runtime.apple_not_started" as const, data: {} }
              : { code: "runtime.not_installed" as const, data: { runtime: "apple-container" } },
        };
  return new FakeRuntime({ id: "apple-container", detection });
}

interface Mac {
  h: Harness;
  runner: ScriptedRunner;
  apple: FakeRuntime;
  clock: { now: number };
}

/**
 * A Mac. The commands the install runs are answered from recordings; the tool
 * "appears" once the package was opened and two polls have passed, and the
 * system start makes the fake runtime work.
 */
function mac(
  state: "missing" | "stopped" | "running",
  options: {
    inputs?: MachineInputs;
    localMachine?: NonNullable<Parameters<typeof openHarness>[0]>["localMachine"];
    start?: ScriptedRule["result"];
    open?: ScriptedRule["result"];
    appears?: boolean;
    sampleDataset?: NonNullable<Parameters<typeof openHarness>[0]>["sampleDataset"];
  } = {},
): Mac {
  const apple = appleFake(state);
  const clock = { now: 1_000_000 };
  let opened = false;
  let polls = 0;
  const ready = () => {
    apple.detection = { ...apple.detection, available: true, version: "1.6.1", problem: null };
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
      argv: ["container", "--version"],
      result: () =>
        opened && options.appears !== false && ++polls > 2
          ? { exitCode: 0, stdout: "container CLI version 1.6.1 (build: release, commit: 804209b)\n", stderr: "" }
          : { exitCode: 127, stdout: "", stderr: "not found" },
    },
    {
      argv: START,
      result: (argv) => {
        const result = typeof startResult === "function" ? startResult(argv) : startResult;
        if (result.exitCode === 0) ready();
        return result;
      },
    },
  ];
  const runner = new MacRunner(rules);
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
      sleep: async (ms) => {
        clock.now += ms;
      },
      now: () => clock.now,
      toolExists: () => false,
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

// Criterion: the wizard shows the kernel and init steps with sizes before the engine pull.

test("before any click the view already holds the plan of a Mac without the tool, and nothing for a Mac that has it", async () => {
  const missing = mac("missing");
  expect((await localView(missing.h)).plan).toEqual([
    { id: "installer", size: pin.size },
    { id: "approve", size: null },
    { id: "kernel", size: KERNEL_SIZE },
    { id: "init", size: null },
    { id: "engine", size: ENGINE_SIZE },
  ]);
  expect((await localView(mac("stopped").h)).plan?.map((step) => step.id)).toEqual(["kernel", "init", "engine"]);
  expect((await localView(mac("running").h)).plan).toBeNull();
});

test("the step list is complete, with the kernel's size and no size for the startup files, before the first step starts", async () => {
  const { h } = mac("missing");
  const views = watch(h);
  await eventually(async () => views.length > 0);

  const response = await send(h, "POST", "/api/local-engine/install");
  expect(response.status).toBe(202);
  const accepted = (await response.json()) as LocalEngineView;
  expect(accepted.install?.steps).toEqual([
    { id: "installer", size: pin.size },
    { id: "approve", size: null },
    { id: "kernel", size: KERNEL_SIZE },
    { id: "init", size: null },
    { id: "engine", size: ENGINE_SIZE },
  ]);
  // The first picture of the install is already complete and has not moved past the first step.
  expect(accepted.install).toMatchObject({ phase: "preparing", step: "installer" });

  await eventually(async () => (await localView(h)).state === "ready");
  const installViews = views.filter((view) => view.install !== null).map((view) => view.install);
  for (const install of installViews) expect(ids(install?.steps ?? [])).toEqual(["installer", "approve", "kernel", "init", "engine"]);
  // The steps came in order, and the engine's pull came last.
  const seen = installViews.map((install) => install?.step).filter((step, index, all) => step !== all[index - 1]);
  expect(seen).toEqual(["installer", "approve", "kernel", "init", "engine"]);
  const firstEngine = installViews.findIndex((install) => install?.step === "engine");
  expect(installViews.slice(0, firstEngine).every((install) => install?.phase === "preparing")).toBe(true);
  expect(installViews[firstEngine]?.phase).toBe("pulling");
  // The installer's progress was reported in bytes.
  expect(installViews.some((install) => install?.step === "installer" && install.stepReceived === pin.size)).toBe(true);
});

test("a Mac whose tool never ran shows only the kernel, the startup files and the engine, and downloads no installer", async () => {
  const { h, runner } = mac("stopped");
  const accepted = (await (await send(h, "POST", "/api/local-engine/install")).json()) as LocalEngineView;
  expect(accepted.install?.steps).toEqual([
    { id: "kernel", size: KERNEL_SIZE },
    { id: "init", size: null },
    { id: "engine", size: ENGINE_SIZE },
  ]);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(files.requests).toEqual([]);
  expect(runner.calls.some((call) => call[0] === "open")).toBe(false);
  expect(runner.calls).toContainEqual(START);
});

test("a Mac that already has the tool running installs the engine alone, as any other computer does", async () => {
  const { h, runner } = mac("running");
  const accepted = (await (await send(h, "POST", "/api/local-engine/install")).json()) as LocalEngineView;
  expect(accepted.install?.steps).toEqual([{ id: "engine", size: ENGINE_SIZE }]);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(runner.calls).toEqual([]);
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

test("a system start that fails ends in mac.start_failed at the step it stopped in", async () => {
  const { h } = mac("missing", { start: recorded("apple-container", "system-start-failed") });
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "failed");
  const view = await localView(h);
  expect(view.problem).toEqual({ code: "mac.start_failed", data: { step: "kernel", exitCode: 1 } });
  expect(view.install).toMatchObject({ phase: "failed", step: "kernel" });
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

test("without enough disk the install refuses before downloading anything, counting the installer and the kernel", async () => {
  const needed = Math.ceil((pin.size + KERNEL_SIZE + ENGINE_SIZE) * 1.2);
  const small = openHarness({
    enginePollMs: 50,
    localMachine: MAC,
    runtimes: { "apple-container": appleFake("missing") },
    machine: recordedMachine(macInputs("26")),
    freeBytes: () => ENGINE_SIZE * 1.3,
    macSetup: { runner: new ScriptedRunner([]), installer: pin },
  });
  open.push(small);
  const response = await send(small, "POST", "/api/local-engine/install");
  expect(response.status).toBe(409);
  const error = await errorOf(response);
  expect(error.code).toBe("install.not_enough_space");
  expect(error.data.needed).toBe(needed);
  expect(files.requests).toEqual([]);
});

// Criterion: the recorded start command always carries the memory and CPU flags and the rest.

test("the container starts with the caps, the loopback publish, the bind mount, the fixed name and the platform, and no restart flag", async () => {
  const { h, apple } = mac("missing");
  await send(h, "POST", "/api/local-engine/install");
  await eventually(async () => (await localView(h)).state === "ready");

  const [started] = apple.starts;
  const argv = started?.argv ?? [];
  expect(argv.slice(0, 4)).toEqual(["container", "run", "-d", "--name"]);
  expect(argv[argv.indexOf("--name") + 1]).toBe(CONTAINER_NAME);
  expect(argv[argv.indexOf("--platform") + 1]).toBe("linux/arm64");
  expect(argv).toContain("--memory");
  expect(argv).toContain("--cpus");
  expect(argv[argv.indexOf("-p") + 1]).toMatch(/^127\.0\.0\.1:\d+:3000$/);
  expect(argv[argv.indexOf("-v") + 1]).toBe(`${join(h.dataFolder, "engine-data")}:/var/www/data`);
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
