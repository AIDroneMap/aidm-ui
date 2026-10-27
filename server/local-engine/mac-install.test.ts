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
import { CONTAINER_NAME, containerConfigFolder } from "../packages/container-package.ts";
import type { InstallerPin } from "../runtimes/apple-container-installer.ts";
import { SAMPLE_DATASET } from "../sample/sample-dataset.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

const GiB = 1024 ** 3;
const ENGINE_SIZE = 622_710_197;
const KERNEL_SIZE = 696_573_576;
/** Spelled out here on purpose: the tool is always called by this path. */
const TOOL = "/usr/local/bin/container";
const START = [TOOL, "system", "start", "--enable-kernel-install"];

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
  /** Runs just before the system start, for a test that needs something to happen around it. */
  beforeStart: (() => Promise<void>) | undefined;

  override run(argv: string[]) {
    return super.run(argv[0] === "open" ? ["open", "<installer>"] : argv);
  }

  override async stream(argv: string[], options: Parameters<ScriptedRunner["stream"]>[1]) {
    if (argv.join(" ") === START.join(" ")) await this.beforeStart?.();
    return super.stream(argv, options);
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
    /** Replaces the wait between two polls, which by default only moves the clock. */
    sleep?: (ms: number) => Promise<void>;
    beforeStart?: () => Promise<void>;
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
      argv: [TOOL, "--version"],
      result: () =>
        opened && options.appears !== false && ++polls > 2
          ? { exitCode: 0, stdout: "container CLI version 1.6.1 (build: release, commit: 804209b)\n", stderr: "" }
          : { exitCode: 127, stdout: "", stderr: "not found" },
    },
    {
      argv: START,
      result: async (argv) => {
        const result = typeof startResult === "function" ? await startResult(argv) : startResult;
        if (result.exitCode === 0) ready();
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

test("before any click the view already holds the plan of a Mac without the tool, and nothing for a Mac that has it", async () => {
  const missing = mac("missing");
  expect((await localView(missing.h)).plan).toEqual([
    { id: "installer", size: pin.size },
    { id: "approve", size: null },
    { id: "kernel", size: KERNEL_SIZE },
    { id: "init", size: null },
    { id: "engine", size: ENGINE_SIZE },
  ]);
  // A tool that was there before may not be release 1.6.1, so the size measured for that release is not shown.
  expect((await localView(mac("stopped").h)).plan).toEqual([
    { id: "kernel", size: null },
    { id: "init", size: null },
    { id: "engine", size: ENGINE_SIZE },
  ]);
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
  // The steps came in order, and the engine's download came last.
  const seen = installViews.map((install) => install?.step).filter((step, index, all) => step !== all[index - 1]);
  expect(seen).toEqual(["installer", "approve", "kernel", "init", "engine"]);
  const firstEngine = installViews.findIndex((install) => install?.step === "engine");
  expect(installViews.slice(0, firstEngine).every((install) => install?.phase === "preparing")).toBe(true);
  expect(installViews[firstEngine]?.phase).toBe("pulling");
  // The installer's progress was reported in bytes.
  expect(installViews.some((install) => install?.step === "installer" && install.stepReceived === pin.size)).toBe(true);
});

test("a Mac whose tool never ran shows only the kernel, the startup files and the engine, with no kernel size, and downloads no installer", async () => {
  const { h, runner } = mac("stopped");
  const accepted = (await (await send(h, "POST", "/api/local-engine/install")).json()) as LocalEngineView;
  expect(accepted.install?.steps).toEqual([
    { id: "kernel", size: null },
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
  // The installer is claimed to be big, so its share is what the check cannot cover. Nothing is downloaded, so the claim is never tested.
  const bigInstaller = { ...pin, size: 3 * GiB };
  // One disk holds it all: the engine's download, the installer and the kernel in the data folder, and the
  // runtime's copy and the unpacked layers next to them (the fake runtime makes one copy).
  const extra = Math.ceil((bigInstaller.size + KERNEL_SIZE) * 1.2);
  const needed = Math.ceil(ENGINE_SIZE + 0.2 * ENGINE_SIZE + extra + Math.ceil((1 + 2.8) * ENGINE_SIZE + 0.2 * ENGINE_SIZE));
  // Room for the engine alone, and for no more.
  const free = 4 * GiB;
  const small = openHarness({
    enginePollMs: 50,
    localMachine: MAC,
    runtimes: { "apple-container": appleFake("missing") },
    machine: recordedMachine(macInputs("26")),
    freeBytes: () => free,
    macSetup: { runner: new ScriptedRunner([]), installer: bigInstaller },
  });
  open.push(small);
  const response = await send(small, "POST", "/api/local-engine/install");
  expect(response.status).toBe(409);
  expect(await errorOf(response)).toEqual({ code: "install.not_enough_space", data: { needed, free } });
  expect(files.requests).toEqual([]);
});

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
