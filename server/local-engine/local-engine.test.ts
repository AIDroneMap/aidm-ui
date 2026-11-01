import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { EngineView, InstallProgressView, LocalEngineView, RunView, SampleView } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { linuxInputs, podmanRules, recordedMachine } from "../../test-support/recorded-machine.ts";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { imageFolder } from "../images/image-download.ts";
import { DOWNLOAD_FREE_DISK_MARGIN, IMAGE_UNPACKED_FACTOR, SAMPLE_JOB_PEAK_MEMORY } from "../machine/thresholds.ts";
import { TaskClient } from "../task-api/task-client.ts";
import { eventually, freePort, openHarness, type Harness } from "../testing/harness.ts";
import { SAMPLE_DATASET } from "../sample/sample-dataset.ts";
import { CONTAINER_NAME, containerConfigFolder, ENGINE_CONFIG_FILE_NAME } from "../packages/container-package.ts";

const GiB = 1024 ** 3;
const DIGEST_2_7_0 = "sha256:a16acea2c75ab17204748fe3e28a19df5ec18c0c1f3af875cdc371158876e7e3";
const IMAGE_2_7_0 = `ghcr.io/aidronemap/aidm-api@${DIGEST_2_7_0}`;
const PINNED_2_7_0 = { repository: "ghcr.io/aidronemap/aidm-api", digest: DIGEST_2_7_0 };
const SIZE_2_7_0 = 573_636_504;
/** The bytes a download of the fake image source reports. */
const FAKE_DOWNLOAD_SIZE = 3 * 1024 * 1024;
/** 32 GiB less 20 percent, the way the default is made. */
const DEFAULT_MEMORY = Math.floor(32 * GiB - 0.2 * 32 * GiB);

const open: Harness[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.stop();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function start(options: Parameters<typeof openHarness>[0] = {}): Harness {
  const harness = openHarness({ enginePollMs: 50, ...options });
  open.push(harness);
  return harness;
}

function send(h: Harness, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${h.base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function getJson<T>(h: Harness, path: string): Promise<T> {
  return (await (await send(h, "GET", path)).json()) as T;
}

const localView = (h: Harness) => getJson<LocalEngineView>(h, "/api/local-engine");
const engineList = (h: Harness) => getJson<EngineView[]>(h, "/api/engines");

async function errorOf(response: Response): Promise<ApiError> {
  return ((await response.json()) as { error: ApiError }).error;
}

function podman(h: Harness): FakeRuntime {
  return h.runtimes.podman as FakeRuntime;
}

async function installAndWaitReady(h: Harness): Promise<LocalEngineView> {
  const response = await send(h, "POST", "/api/local-engine/install");
  expect(response.status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");
  return localView(h);
}

/** The token the engine reads from the config file in the data folder. */
function configTokenOf(h: Harness): string {
  const text = readFileSync(join(containerConfigFolder(h.dataFolder), ENGINE_CONFIG_FILE_NAME), "utf8");
  return (JSON.parse(text) as { token: string }).token;
}

/** The engine's own token, which no response may carry. */
function tokenOf(h: Harness): string {
  const engine = h.engineStore.local();
  if (engine === null) throw new Error("There is no local engine.");
  return engine.token;
}

/** Reads server-sent events as they arrive. */
function listen(h: Harness, path: string) {
  const events: Array<{ event: string; data: unknown; text: string }> = [];
  const abort = new AbortController();
  const done = (async () => {
    const response = await fetch(`${h.base}${path}`, { signal: abort.signal });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value);
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = block.split("\n").find((line) => line.startsWith("event: "));
          const data = block.split("\n").find((line) => line.startsWith("data: "));
          if (name !== undefined && data !== undefined) {
            events.push({ event: name.slice(7), data: JSON.parse(data.slice(6)) as unknown, text: block });
          }
        }
      }
    } catch {
      // Aborted by close().
    }
  })();
  const stream = {
    events,
    async close() {
      abort.abort();
      await done;
    },
  };
  cleanups.push(() => stream.close());
  return stream;
}

const asView = (data: unknown) => data as LocalEngineView;

/** The room an install needs on one disk when none of the download is there yet and the fake runtime's load makes one copy. */
function neededFor(size: number, bytesAlreadyOnDisk = 0, loadCopies = 1): number {
  const forDownload = size - bytesAlreadyOnDisk + DOWNLOAD_FREE_DISK_MARGIN * size;
  const forRuntime = Math.ceil((loadCopies + IMAGE_UNPACKED_FACTOR) * size + DOWNLOAD_FREE_DISK_MARGIN * size);
  return Math.ceil(forDownload + forRuntime);
}

// Criterion: with the fake runtime, the install downloads and loads 2.7.0, shows progress with a total, starts the engine, and the engines list shows it ready on the loopback.

test("the install downloads and loads the built-in 2.7.0 package, shows progress with a total, and the engine is ready on the loopback", async () => {
  const h = start();
  expect((await localView(h)).state).toBe("not_installed");
  const stream = listen(h, "/api/local-engine/events");
  await eventually(async () => stream.events.length > 0);

  const response = await send(h, "POST", "/api/local-engine/install");
  expect(response.status).toBe(202);
  const accepted = (await response.json()) as LocalEngineView;
  expect(["installing", "starting", "ready", "busy"]).toContain(accepted.state);
  expect(accepted.install).toMatchObject({ size: SIZE_2_7_0, retries: 0 });

  await eventually(async () => (await localView(h)).state === "ready");
  expect(h.images.downloads).toEqual([PINNED_2_7_0]);
  expect(podman(h).loads).toEqual([IMAGE_2_7_0]);

  const views = stream.events.filter((event) => event.event === "local-engine").map((event) => asView(event.data));
  expect(views.some((view) => view.state === "installing" && view.install?.size === SIZE_2_7_0)).toBe(true);
  expect(views.some((view) => (view.install?.layersTotal ?? 0) > 0)).toBe(true);
  expect(views.some((view) => view.state === "starting")).toBe(true);

  const engines = await engineList(h);
  expect(engines).toHaveLength(1);
  expect(engines[0]).toMatchObject({ kind: "local", state: "ready", enabled: true });
  expect(engines[0]?.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(engines[0]?.info?.version).toBe("2.7.0");

  const view = await localView(h);
  expect(view).toMatchObject({
    installed: { packageVersion: "2.7.0", variant: "linux-amd64-cpu", kind: "container", runtime: "podman" },
    engineId: engines[0]?.id,
    state: "ready",
    install: { phase: "done" },
    runtime: { chosen: "podman", available: ["podman"], preferred: null },
    warnings: [],
    problem: null,
  });
});

// Criterion: too little free disk refuses the download before it starts.

test("with too little free disk the install is refused before any download, with both sizes", async () => {
  const h = start({ freeBytes: () => 700_000_000 });
  const response = await send(h, "POST", "/api/local-engine/install");
  expect(response.status).toBe(409);
  expect(await errorOf(response)).toEqual({
    code: "install.not_enough_space",
    data: { needed: neededFor(SIZE_2_7_0), free: 700_000_000 },
  });
  expect(h.images.downloads).toEqual([]);
  expect(podman(h).loads).toEqual([]);
  expect(await localView(h)).toMatchObject({ state: "not_installed", install: null, installed: null });
  expect(await engineList(h)).toEqual([]);
});

// Criterion: the download shows its progress, and a failed download or load ends the install in failed.

test("the progress of an install goes from the download to the load to the start, and the bytes grow to the size of the image", async () => {
  const h = start();
  const stream = listen(h, "/api/local-engine/events");
  await eventually(async () => stream.events.length > 0);
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");

  const installs = stream.events.flatMap((event) => asView(event.data).install ?? []);
  const phases = installs.map((install) => install.phase);
  const first = (phase: InstallProgressView["phase"]) => phases.indexOf(phase);
  expect(first("pulling")).toBeGreaterThanOrEqual(0);
  expect(first("loading")).toBeGreaterThan(first("pulling"));
  expect(first("starting")).toBeGreaterThan(first("loading"));
  expect(phases.lastIndexOf("pulling")).toBeLessThan(first("loading"));

  const received = installs.filter((install) => install.phase === "pulling").map((install) => install.stepReceived ?? 0);
  expect(received).toEqual([...received].sort((a, b) => a - b));
  expect(received.at(-1)).toBe(FAKE_DOWNLOAD_SIZE);
  expect(installs.filter((install) => install.phase === "pulling").some((install) => install.layersTotal === 2)).toBe(true);
  expect(installs.find((install) => install.phase === "loading")).toMatchObject({ layersTotal: 2, layersDone: 2, speed: null });
});

test("a download that fails ends in failed with its cause, nothing is installed, and a later install works", async () => {
  const h = start();
  const stalled: ApiError = { code: "download.stalled", data: { seconds: 300 } };
  h.images.failNext(stalled);
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "failed");
  const failed = await localView(h);
  expect(failed.problem).toEqual({ code: "install.pull_failed", data: { cause: stalled } });
  expect(failed.install?.phase).toBe("failed");
  expect(failed.installed).toBeNull();
  expect(await engineList(h)).toEqual([]);
  expect(podman(h).loads).toEqual([]);

  await installAndWaitReady(h);
  const view = await localView(h);
  expect(view.problem).toBeNull();
  expect(view.installed?.packageVersion).toBe("2.7.0");
  expect(h.images.downloads).toHaveLength(2);
  expect(podman(h).loads).toEqual([IMAGE_2_7_0]);
});

test("a load that fails ends in failed and keeps the download, and the next install loads it again and removes it", async () => {
  const h = start();
  const folder = imageFolder(h.dataFolder, PINNED_2_7_0);
  podman(h).failNextLoads(1);
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "failed");
  const failed = await localView(h);
  expect(failed.problem).toEqual({ code: "install.load_failed", data: { exitCode: 1 } });
  expect(failed.installed).toBeNull();
  expect(await engineList(h)).toEqual([]);
  expect(existsSync(join(folder, "index.json"))).toBe(true);
  expect(podman(h).loads).toEqual([IMAGE_2_7_0]);

  await installAndWaitReady(h);
  expect(podman(h).loads).toEqual([IMAGE_2_7_0, IMAGE_2_7_0]);
  expect((await localView(h)).problem).toBeNull();
  expect(existsSync(folder)).toBe(false);
});

test("the download is removed once the engine started from a fresh install, and the engine runs the image the runtime verified", async () => {
  const h = start();
  await installAndWaitReady(h);
  expect(existsSync(imageFolder(h.dataFolder, PINNED_2_7_0))).toBe(false);
  expect(podman(h).starts[0]?.spec.image).toBe(IMAGE_2_7_0);
  expect(podman(h).images.has(IMAGE_2_7_0)).toBe(true);
});

// Criterion: the start command carries the loopback publish, the config file with the token, the caps, the bind mounts and the fixed name.

test("the start command carries the loopback publish, the config file with the token, the caps, the bind mounts and the name", async () => {
  const h = start();
  await installAndWaitReady(h);
  const [started] = podman(h).starts;
  const argv = started?.argv ?? [];
  const port = new URL((await engineList(h))[0]?.address ?? "").port;

  const after = (flag: string) => argv[argv.indexOf(flag) + 1];
  expect(after("-p")).toBe(`127.0.0.1:${port}:3000`);
  expect(after("--name")).toBe("aidm-local-engine");
  expect(after("-v")).toBe(`${join(h.dataFolder, "engine-data")}:/var/www/data:Z`);
  expect(after("--memory")).toBe(`${DEFAULT_MEMORY}b`);
  expect(after("--cpus")).toBe("8");
  expect(argv).toContain("-d");

  // Everything after the image name goes to the task API.
  const image = argv.indexOf(IMAGE_2_7_0);
  expect(image).toBeGreaterThan(0);
  expect(argv.slice(image + 1)).toEqual(["--config", "/etc/aidm-ui/task-api.json"]);
  // The command line is readable by every user of the computer, so the token is not on it.
  expect(argv.join(" ")).not.toContain(tokenOf(h));
  expect(argv).toContain(`${containerConfigFolder(h.dataFolder)}:/etc/aidm-ui:ro,Z`);
  expect(configTokenOf(h)).toBe(tokenOf(h));
  expect(argv.some((part) => part.startsWith("--restart"))).toBe(false);
  expect(existsSync(join(h.dataFolder, "engine-data"))).toBe(true);
  expect((await localView(h)).caps).toEqual({
    memoryBytes: DEFAULT_MEMORY,
    cpus: 8,
    maxMemoryBytes: DEFAULT_MEMORY,
    maxCpus: 8,
    applied: { memoryBytes: DEFAULT_MEMORY, cpus: 8 },
  });
});

test("the engine data folder setting moves the bind mount", async () => {
  const h = start();
  const elsewhere = mkdtempSync(join(os.tmpdir(), "aidm-ui-engine-data-"));
  cleanups.push(() => rmSync(elsewhere, { recursive: true, force: true }));
  h.settings.set("engine.dataFolder", elsewhere);
  await installAndWaitReady(h);
  expect(podman(h).starts[0]?.spec.mounts).toEqual([
    { hostPath: elsewhere, containerPath: "/var/www/data", readOnly: false },
    { hostPath: containerConfigFolder(h.dataFolder), containerPath: "/etc/aidm-ui", readOnly: true },
  ]);
});

// Criterion: lowering the caps changes the next start command.

test("lowering the caps changes the next start command, and not the engine that runs", async () => {
  const h = start();
  await installAndWaitReady(h);

  const response = await send(h, "PUT", "/api/local-engine/caps", { memoryBytes: 4 * GiB, cpus: 2 });
  expect(response.status).toBe(200);
  const lowered = (await response.json()) as LocalEngineView;
  expect(lowered.caps).toMatchObject({ memoryBytes: 4 * GiB, cpus: 2, maxMemoryBytes: DEFAULT_MEMORY, maxCpus: 8 });
  // The running engine still has what it was started with.
  expect(lowered.caps.applied).toEqual({ memoryBytes: DEFAULT_MEMORY, cpus: 8 });

  expect((await h.localEngine.stop()).ok).toBe(true);
  const stopped = await localView(h);
  expect(stopped.state).toBe("stopped");
  expect(stopped.caps.applied).toBeNull();
  expect((await engineList(h))[0]).toMatchObject({ state: "stopped", enabled: false });

  expect((await h.localEngine.start()).ok).toBe(true);
  await eventually(async () => (await localView(h)).state === "ready");
  const argv = podman(h).starts[1]?.argv ?? [];
  expect(argv[argv.indexOf("--memory") + 1]).toBe(`${4 * GiB}b`);
  expect(argv[argv.indexOf("--cpus") + 1]).toBe("2");
  expect((await localView(h)).caps.applied).toEqual({ memoryBytes: 4 * GiB, cpus: 2 });
  // The same token and the same engine row after a stop and a start.
  expect(argv.join(" ")).not.toContain(tokenOf(h));
  expect(configTokenOf(h)).toBe(tokenOf(h));
  expect(await engineList(h)).toHaveLength(1);
});

test("caps outside the limits are refused with their codes and limits, and change nothing", async () => {
  const h = start();
  const before = (await localView(h)).caps;
  const put = (body: unknown) => send(h, "PUT", "/api/local-engine/caps", body);
  const memory = { code: "caps.memory_invalid" as const, data: { min: GiB, max: DEFAULT_MEMORY } };
  const cpus = { code: "caps.cpus_invalid" as const, data: { min: 1, max: 8 } };

  for (const memoryBytes of [GiB - 1, DEFAULT_MEMORY + 1, 2.5 * GiB + 0.5]) {
    const response = await put({ memoryBytes, cpus: 2 });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual(memory);
  }
  for (const value of [0, 9, 1.5, -1]) {
    const response = await put({ memoryBytes: 4 * GiB, cpus: value });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual(cpus);
  }
  for (const body of [{}, { memoryBytes: "4", cpus: 2 }, { memoryBytes: 4 * GiB }, { cpus: 2 }]) {
    const response = await put(body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("api.invalid_body");
  }
  expect((await localView(h)).caps).toEqual(before);
  // The limits themselves are allowed.
  expect((await put({ memoryBytes: GiB, cpus: 1 })).status).toBe(200);
  expect((await put({ memoryBytes: DEFAULT_MEMORY, cpus: 8 })).status).toBe(200);
});

test("the default memory leaves 2 GiB on a computer where 20 percent is less", async () => {
  const h = start({ localMachine: { platform: "linux", arch: "x64", totalMemory: 9 * GiB, cpuCount: 4 } });
  expect((await localView(h)).caps).toMatchObject({ memoryBytes: 7 * GiB, maxMemoryBytes: 7 * GiB, cpus: 4, maxCpus: 4 });
});

// Criterion: the logs stream shows the lines the runtime emits, and they are in engine.log.

test("the logs stream shows lines the runtime emits without a reload, and they are in engine.log", async () => {
  const h = start();
  await installAndWaitReady(h);
  const runtime = podman(h);
  runtime.emitLog(CONTAINER_NAME, "before the page opened");

  const stream = listen(h, "/api/local-engine/logs");
  await eventually(async () => stream.events.length > 0);
  expect(stream.events[0]).toMatchObject({ event: "log", data: { lines: ["before the page opened"] } });

  runtime.emitLog(CONTAINER_NAME, "Server listening on port 3000");
  await eventually(async () =>
    stream.events.some((event) => (event.data as { lines: string[] }).lines.includes("Server listening on port 3000")),
  );

  const file = join(h.dataFolder, "logs", "engine.log");
  await eventually(async () => readFileSync(file, "utf8").includes("Server listening on port 3000"));
  expect(readFileSync(file, "utf8")).toBe("before the page opened\nServer listening on port 3000\n");

  // A page that opens later gets what happened before at once.
  const later = listen(h, "/api/local-engine/logs");
  await eventually(async () => later.events.length > 0);
  expect((later.events[0]?.data as { lines: string[] }).lines).toEqual([
    "before the page opened",
    "Server listening on port 3000",
  ]);
});

test("after aidm-ui restarts the log of an engine that still runs is followed again", async () => {
  const h = start();
  await installAndWaitReady(h);
  await h.localEngine.logs.stop();
  podman(h).emitLog(CONTAINER_NAME, "while nobody listened");
  await h.localEngine.resume();
  expect(h.localEngine.logs.isFollowing()).toBe(true);
  podman(h).emitLog(CONTAINER_NAME, "after the restart");
  await eventually(async () => h.localEngine.logs.lines().includes("after the restart"));
  expect(h.localEngine.logs.lines()).not.toContain("while nobody listened");
});

// Criterion: the sample job completes on the local engine.

test("the sample job completes on the local engine, end to end", async () => {
  const encoder = new TextEncoder();
  const scratch = mkdtempSync(join(os.tmpdir(), "aidm-ui-local-sample-"));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
  const zipPath = join(scratch, "dataset.zip");
  writeStoredZip(zipPath, [
    { name: "DJI_0001.JPG", data: encoder.encode("image one ".repeat(10)) },
    { name: "DJI_0002.JPG", data: encoder.encode("image two ".repeat(12)) },
  ]);
  const zip = new Uint8Array(readFileSync(zipPath));
  const files = new FakeFileServer({ "/dataset.zip": zip });
  await files.start();
  cleanups.push(() => files.stop());
  const hash = new Bun.CryptoHasher("sha256").update(zip).digest("hex");

  const h = start({
    runPollMs: 30,
    sampleDataset: {
      ...SAMPLE_DATASET,
      url: files.url("/dataset.zip"),
      size: zip.length,
      sha256: hash,
      imageCount: 2,
      fileName: "dataset.zip",
    },
  });
  const ready = await installAndWaitReady(h);

  // The sample job counts the memory the engine was started with.
  const offered = await getJson<SampleView>(h, "/api/sample");
  expect(offered.engines).toEqual([
    {
      engineId: ready.engineId as number,
      engineName: "This computer",
      local: true,
      offered: true,
      memoryCap: DEFAULT_MEMORY,
      reason: null,
    },
  ]);
  expect(DEFAULT_MEMORY).toBeGreaterThan(SAMPLE_JOB_PEAK_MEMORY);

  const started = await send(h, "POST", "/api/sample/start", { engineId: ready.engineId });
  expect(started.status).toBe(202);
  const run = (await started.json()) as RunView;
  const engine = podman(h).engine(CONTAINER_NAME);
  if (engine === undefined) throw new Error("The fake runtime has no engine.");

  await eventually(async () => engine.tasks.size === 1 && [...engine.tasks.values()][0]?.committed === true);
  const [uuid] = [...engine.tasks.keys()] as [string];
  expect(engine.uploads.map((upload) => upload.fileName)).toEqual(["DJI_0001.JPG", "DJI_0002.JPG"]);
  await eventually(async () => (await getJson<RunView>(h, `/api/runs/${run.id}`)).state === "queued");

  engine.setTask(uuid, { statusCode: 20, processingTime: 2000, progress: 40 });
  await eventually(async () => (await getJson<RunView>(h, `/api/runs/${run.id}`)).state === "processing");
  const results = zip;
  engine.setTask(uuid, { statusCode: 40, processingTime: 9000, progress: 100, results });
  await eventually(async () => (await getJson<RunView>(h, `/api/runs/${run.id}`)).state === "completed");
  await eventually(async () => (await getJson<RunView>(h, `/api/runs/${run.id}`)).resultsAvailable);

  const download = await send(h, "GET", `/api/runs/${run.id}/results`);
  expect(download.status).toBe(200);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(results);
  // The engine row of the run is the local one.
  expect(await getJson<RunView>(h, `/api/runs/${run.id}`)).toMatchObject({ engineName: "This computer", engineLocal: true });
});

test("the sample job counts the cap the engine was started with, and the configured cap when it is not running", async () => {
  const h = start();
  await installAndWaitReady(h);
  const memoryCap = async () => (await getJson<SampleView>(h, "/api/sample")).engines[0]?.memoryCap;
  expect(await memoryCap()).toBe(DEFAULT_MEMORY);

  await send(h, "PUT", "/api/local-engine/caps", { memoryBytes: 4 * GiB, cpus: 2 });
  expect(await memoryCap()).toBe(DEFAULT_MEMORY);

  await h.localEngine.stop();
  expect(await memoryCap()).toBe(4 * GiB);
  await h.localEngine.start();
  await eventually(async () => (await localView(h)).state === "ready");
  const offer = (await getJson<SampleView>(h, "/api/sample")).engines[0];
  expect(offer).toMatchObject({ memoryCap: 4 * GiB, offered: false });
  expect(offer?.reason).toEqual({ code: "sample.memory_below_peak", data: { cap: 4 * GiB, peak: SAMPLE_JOB_PEAK_MEMORY } });
});

// Where the runtime cannot enforce a memory cap.

test("only the memory cap is left out, with a warning, when the runtime cannot enforce just that one", async () => {
  const h = start({ runtimes: { podman: new FakeRuntime({ detection: { memoryCapEnforced: false } }) } });
  // The warning is there before the install, so the page can say it first.
  expect((await localView(h)).warnings).toEqual([{ code: "local.memory_cap_not_enforced", data: { runtime: "podman" } }]);

  await installAndWaitReady(h);
  const started = podman(h).starts[0];
  expect(started?.spec.memoryBytes).toBeNull();
  expect(started?.argv).not.toContain("--memory");
  expect(started?.argv).toContain("--cpus");
  const view = await localView(h);
  expect(view.warnings).toEqual([{ code: "local.memory_cap_not_enforced", data: { runtime: "podman" } }]);
  expect(view.caps.applied).toEqual({ memoryBytes: null, cpus: 8 });
  // The configured cap is still shown, so the operator sees what they asked for.
  expect(view.caps.memoryBytes).toBe(DEFAULT_MEMORY);
});

test("only the CPU cap is left out, with its own warning, when the runtime cannot enforce just that one", async () => {
  const h = start({ runtimes: { podman: new FakeRuntime({ detection: { cpuCapEnforced: false } }) } });
  expect((await localView(h)).warnings).toEqual([{ code: "local.cpu_cap_not_enforced", data: { runtime: "podman" } }]);

  await installAndWaitReady(h);
  const started = podman(h).starts[0];
  expect(started?.spec.cpus).toBeNull();
  expect(started?.argv).toContain("--memory");
  expect(started?.argv).not.toContain("--cpus");
  const view = await localView(h);
  expect(view.warnings).toEqual([{ code: "local.cpu_cap_not_enforced", data: { runtime: "podman" } }]);
  expect(view.caps.applied).toEqual({ memoryBytes: DEFAULT_MEMORY, cpus: null });
  expect(view.caps.cpus).toBe(8);
});

test("a runtime that enforces neither cap gets both warnings and no cap", async () => {
  const h = start({
    runtimes: { podman: new FakeRuntime({ detection: { memoryCapEnforced: false, cpuCapEnforced: false } }) },
  });
  expect((await localView(h)).warnings.map((warning) => warning.code)).toEqual([
    "local.memory_cap_not_enforced",
    "local.cpu_cap_not_enforced",
  ]);
  await installAndWaitReady(h);
  expect((await localView(h)).caps.applied).toEqual({ memoryBytes: null, cpus: null });
});

// Runtime choice.

test("Podman is used over Docker when both work, and the operator's choice wins", async () => {
  const h = start({ runtimes: { docker: new FakeRuntime({ id: "docker" }), podman: new FakeRuntime() } });
  const view = await localView(h);
  expect(view.runtime).toEqual({ chosen: "podman", available: ["docker", "podman"], preferred: null });

  const chosen = await send(h, "PUT", "/api/settings/runtime", { runtime: "docker" });
  expect(chosen.status).toBe(200);
  expect(((await chosen.json()) as LocalEngineView).runtime).toMatchObject({ chosen: "docker", preferred: "docker" });
  expect(h.settings.get("runtime.preferred")).toBe("docker");

  await installAndWaitReady(h);
  expect(h.runtimes.docker?.loads).toEqual([IMAGE_2_7_0]);
  expect(h.runtimes.podman?.loads).toEqual([]);
  expect(h.runtimes.docker?.starts).toHaveLength(1);
  expect((await localView(h)).installed?.runtime).toBe("docker");

  // The engine keeps the runtime that has its image, whatever is chosen after.
  await send(h, "PUT", "/api/settings/runtime", { runtime: null });
  expect(await localView(h)).toMatchObject({ runtime: { chosen: "docker", preferred: null }, installed: { runtime: "docker" } });
});

test("a runtime that is not available cannot be chosen", async () => {
  const h = start({ runtimes: { podman: new FakeRuntime(), docker: new FakeRuntime({ id: "docker", detection: { available: false } }) } });
  for (const runtime of ["docker", "apple-container"]) {
    const response = await send(h, "PUT", "/api/settings/runtime", { runtime });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toEqual({ code: "runtime.not_available", data: { runtime } });
  }
  expect(h.settings.get("runtime.preferred")).toBeNull();
  for (const body of [{}, { runtime: "lxc" }, { runtime: 3 }]) {
    const response = await send(h, "PUT", "/api/settings/runtime", body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("api.invalid_body");
  }
});

test("without a working runtime the install is refused where Podman cannot be set up", async () => {
  // The machine check finds a working tool, so the setup is not needed and the install keeps its own refusal.
  const h = start({
    machine: recordedMachine(linuxInputs({ rules: podmanRules("info-rootless") })),
    runtimes: { podman: new FakeRuntime({ detection: { available: false } }) },
  });
  const response = await send(h, "POST", "/api/local-engine/install");
  expect(response.status).toBe(409);
  expect((await errorOf(response)).code).toBe("install.no_runtime");
  expect(podman(h).loads).toEqual([]);
});

test("a computer with no package on offer is refused with the offer's reason", async () => {
  const h = start({ localMachine: { platform: "win32", arch: "x64", totalMemory: 32 * GiB, cpuCount: 8 } });
  const response = await send(h, "POST", "/api/local-engine/install");
  expect(response.status).toBe(409);
  expect(await errorOf(response)).toEqual({
    code: "install.not_offered",
    data: { reason: { code: "machine.windows_not_yet", data: {} } },
  });
});

test("an install that is already running is refused", async () => {
  const h = start();
  const [first, second] = await Promise.all([
    send(h, "POST", "/api/local-engine/install"),
    send(h, "POST", "/api/local-engine/install"),
  ]);
  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual([202, 409]);
  const refused = first.status === 409 ? first : second;
  expect((await errorOf(refused)).code).toBe("install.already_running");
  await h.localEngine.settled();
  expect(podman(h).loads).toHaveLength(1);
  expect(h.images.downloads).toHaveLength(1);
});

// The token.

test("the install makes a token of its own, and the token is in no response and no log", async () => {
  const h = start();
  const seen: string[] = [];
  const record = async (path: string, method = "GET") => {
    seen.push(await (await send(h, method, path)).text());
  };

  const events = listen(h, "/api/local-engine/events");
  const logStream = listen(h, "/api/local-engine/logs");
  await installAndWaitReady(h);
  const token = tokenOf(h);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  const argv = podman(h).starts[0]?.argv ?? [];
  expect(argv.join(" ")).not.toContain(token);
  expect(argv).toContain("--config");
  expect(configTokenOf(h)).toBe(token);
  const engine = (await engineList(h))[0] as EngineView;
  expect((await new TaskClient({ address: engine.address, token }).info()).ok).toBe(true);
  expect((await new TaskClient({ address: engine.address, token: "0".repeat(64) }).info()).ok).toBe(false);

  // The engine itself prints its arguments, and a runtime may print them too: the file and the stream are cleaned.
  podman(h).emitLog(CONTAINER_NAME, `started with --token ${token}`);
  await eventually(async () => h.localEngine.logs.lines().length === 1);

  for (const path of ["/api/local-engine", "/api/engines", "/api/sample", "/api/settings", "/api/machine-check"]) {
    await record(path);
  }
  await events.close();
  await logStream.close();
  seen.push(...events.events.map((event) => event.text), ...logStream.events.map((event) => event.text));
  seen.push(h.logs.join("\n"));
  seen.push(readFileSync(join(h.dataFolder, "logs", "engine.log"), "utf8"));
  for (const text of seen) expect(text).not.toContain(token);
});

test("an install over an installed engine is refused, and the engine, its token and its container stay as they are", async () => {
  const h = start();
  await installAndWaitReady(h);
  const token = tokenOf(h);
  const row = h.engineStore.local()?.id;

  const response = await send(h, "POST", "/api/local-engine/install");
  expect(response.status).toBe(409);
  expect(await errorOf(response)).toEqual({ code: "install.already_installed", data: {} });

  expect(podman(h).loads).toHaveLength(1);
  expect(podman(h).starts).toHaveLength(1);
  expect(podman(h).removals).toEqual([]);
  expect(tokenOf(h)).toBe(token);
  expect(h.engineStore.local()?.id).toBe(row);
  expect((await localView(h)).state).toBe("ready");
});

test("an engine that was stopped is still installed, so an install is refused then too", async () => {
  const h = start();
  await installAndWaitReady(h);
  await h.localEngine.stop();
  const response = await send(h, "POST", "/api/local-engine/install");
  expect(response.status).toBe(409);
  expect((await errorOf(response)).code).toBe("install.already_installed");
});

// Failures.

test("a start that fails ends in failed with the install.start_failed code and the runtime's error", async () => {
  const h = start();
  const runtime = podman(h);
  const original = runtime.start.bind(runtime);
  runtime.start = async () => ({ ok: false, error: { code: "runtime.start_failed", data: { exitCode: 125 } } });
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "failed");

  const view = await localView(h);
  expect(view.problem).toEqual({
    code: "install.start_failed",
    data: { cause: { code: "runtime.start_failed", data: { exitCode: 125 } } },
  });
  expect(view.installed?.packageVersion).toBe("2.7.0");
  expect(view.caps.applied).toBeNull();
  expect((await engineList(h))[0]).toMatchObject({ kind: "local", state: "failed", address: "" });

  // Starting again, once the runtime works, brings the engine up.
  runtime.start = original;
  expect((await h.localEngine.start()).ok).toBe(true);
  await eventually(async () => (await localView(h)).state === "ready");
  expect((await localView(h)).problem).toBeNull();
});

test("a start without an install is refused", async () => {
  const h = start();
  expect(await h.localEngine.start()).toEqual({ ok: false, error: { code: "local.not_installed", data: {} } });
  expect(await h.localEngine.stop()).toEqual({ ok: false, error: { code: "local.not_installed", data: {} } });
});

test("an engine whose container dies becomes unreachable", async () => {
  // The manager would start it again at once; this wait never ends, so the state can be looked at.
  const h = start({ sleep: () => new Promise<void>(() => {}) });
  await installAndWaitReady(h);
  await podman(h).kill(CONTAINER_NAME);
  await eventually(async () => (await localView(h)).state === "unreachable");
  expect((await engineList(h))[0]?.state).toBe("unreachable");
});

test("a local engine that has just started may stay silent for a while without being called unreachable", async () => {
  const silent = (endpoint: ConstructorParameters<typeof TaskClient>[0], options: ConstructorParameters<typeof TaskClient>[1]) =>
    new TaskClient(endpoint, { ...options, fetch: (() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch });
  const patient = start({ clientFor: silent, startingGraceMs: 60_000 });
  const impatient = start({ clientFor: silent, startingGraceMs: 0 });
  await send(patient, "POST", "/api/local-engine/install");
  await send(impatient, "POST", "/api/local-engine/install");
  await eventually(async () => (await localView(impatient)).state === "unreachable");
  expect((await localView(patient)).state).toBe("starting");
});

test("the local engine cannot be edited or removed as a remote one", async () => {
  const h = start();
  await installAndWaitReady(h);
  const { id } = (await engineList(h))[0] as EngineView;
  for (const [method, body] of [["PUT", { name: "Mine" }], ["PUT", { enabled: false }], ["DELETE", undefined]] as const) {
    const response = await send(h, method, `/api/engines/${id}`, body);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("engine.local_not_editable");
  }
  expect((await engineList(h))[0]).toMatchObject({ id, name: "This computer", enabled: true });
});

test("closing the manager leaves the container running", async () => {
  const h = start();
  await installAndWaitReady(h);
  await h.localEngine.close();
  expect(podman(h).stops).toEqual([]);
  expect(podman(h).removals).toEqual([]);
  expect(await podman(h).status(CONTAINER_NAME)).toMatchObject({ ok: true, value: { state: "running" } });
});

// The disk check looks at where the runtime keeps its images.

test("the free space is asked for the data folder when the runtime keeps its images on the same disk, or does not say where", async () => {
  const stored = [os.tmpdir(), null] as const;
  for (const storagePath of stored) {
    const asked: string[] = [];
    const h = start({
      runtimes: { podman: new FakeRuntime({ detection: { storagePath } }) },
      freeBytes: (path) => {
        asked.push(path);
        return 1024 * GiB;
      },
    });
    await installAndWaitReady(h);
    // The preflight in the install route and the one right before the download.
    expect(asked).toEqual(Array(2).fill(h.dataFolder));
  }
});

test("on one disk the room for the download alone is not enough: the runtime's copies and unpacked layers are counted too", async () => {
  const forDownloadOnly = Math.ceil((1 + DOWNLOAD_FREE_DISK_MARGIN) * SIZE_2_7_0);
  const h = start({ freeBytes: () => forDownloadOnly });
  const response = await send(h, "POST", "/api/local-engine/install");
  expect(response.status).toBe(409);
  expect(await errorOf(response)).toEqual({
    code: "install.not_enough_space",
    data: { needed: neededFor(SIZE_2_7_0), free: forDownloadOnly },
  });
  expect(h.images.downloads).toEqual([]);
  expect(podman(h).loads).toEqual([]);
});

// The folder that goes into the mount.

test("an engine data folder that is not a full path, or has a colon in it, stops the start with a log line", async () => {
  const colon = join(os.tmpdir(), "aidm-ui:colon-test");
  cleanups.push(() => rmSync(colon, { recursive: true, force: true }));
  for (const folder of ["engine-data-relative-test", colon]) {
    const h = start();
    h.settings.set("engine.dataFolder", folder);
    expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
    await eventually(async () => (await localView(h)).state === "failed");
    expect((await localView(h)).problem).toMatchObject({ code: "install.start_failed" });
    expect(podman(h).starts).toEqual([]);
    expect(h.logs.some((line) => line.includes("engine data folder"))).toBe(true);
    expect(existsSync(folder)).toBe(false);
  }
});

// A start that fails after the container is running.

test("when the engine cannot be recorded after its container started, the container is stopped and removed and the start fails", async () => {
  const h = start();
  const update = h.engineStore.update.bind(h.engineStore);
  h.engineStore.update = (id, patch) => {
    if (patch.address) throw new Error("database is locked");
    return update(id, patch);
  };
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "failed");

  expect(podman(h).starts).toHaveLength(1);
  expect(podman(h).stops).toEqual([CONTAINER_NAME]);
  expect(podman(h).removals).toEqual([CONTAINER_NAME]);
  expect(await podman(h).status(CONTAINER_NAME)).toEqual({
    ok: true,
    value: { state: "missing", exitCode: null, oomKilled: null },
  });
  const view = await localView(h);
  expect(view.problem).toEqual({
    code: "install.start_failed",
    data: { cause: { code: "server.internal_error", data: {} } },
  });
  expect(view.caps.applied).toBeNull();
  expect(h.logs.some((line) => line.includes("database is locked"))).toBe(true);
  // The image stays, so starting again needs no download.
  expect(podman(h).removedImages).toEqual([]);
});

// A poll that began before a stop and start.

test("an answer to a poll that began before a stop and start is not taken for the engine started after it, on the same port", async () => {
  const port = await freePort();
  const gate = Promise.withResolvers<void>();
  let phase: "open" | "armed" | "held" | "after" = "open";
  const h = start({
    freePort: async () => port,
    startingGraceMs: 60_000,
    clientFor: (endpoint, options) =>
      new TaskClient(endpoint, {
        ...options,
        fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (phase === "open") return fetch(input, init);
          if (phase === "armed") {
            // The old engine answers, and the answer is slow to arrive.
            phase = "held";
            const answer = await fetch(input, init);
            await gate.promise;
            return answer;
          }
          // The new engine has not answered anything yet.
          throw new Error("connection refused");
        }) as unknown as typeof fetch,
      }),
  });
  try {
    await installAndWaitReady(h);
    const oldAddress = (await engineList(h))[0]?.address;
    phase = "armed";
    await eventually(async () => phase === "held");

    expect((await h.localEngine.stop()).ok).toBe(true);
    phase = "after";
    const restarted = h.localEngine.start();
    await eventually(async () => podman(h).starts.length === 2);
    gate.resolve();
    expect((await restarted).ok).toBe(true);

    // The same port, so the address did not change.
    expect((await engineList(h))[0]?.address).toBe(oldAddress);
    expect(new URL(oldAddress ?? "").port).toBe(String(port));
    await Bun.sleep(150);
    expect((await engineList(h))[0]).toMatchObject({ state: "starting", info: null });
    expect((await localView(h)).state).toBe("starting");
  } finally {
    // A failed check must not leave the poll held, or the harness could not stop.
    gate.resolve();
  }
});

// The log reaches the page in batches.

test("a burst of log lines reaches the page in one event and not one event for each line", async () => {
  const h = start();
  await installAndWaitReady(h);
  const stream = listen(h, "/api/local-engine/logs");
  await eventually(async () => stream.events.length > 0);
  const before = stream.events.length;

  const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`);
  for (const line of lines) podman(h).emitLog(CONTAINER_NAME, line);
  const batched = () => stream.events.slice(before).flatMap((event) => (event.data as { lines: string[] }).lines);
  await eventually(async () => batched().length === lines.length);

  expect(batched()).toEqual(lines);
  expect(stream.events.length - before).toBeLessThanOrEqual(2);
});

test("lines that come in separate moments are still delivered, in order", async () => {
  const h = start();
  await installAndWaitReady(h);
  const stream = listen(h, "/api/local-engine/logs");
  await eventually(async () => stream.events.length > 0);
  const before = stream.events.length;
  podman(h).emitLog(CONTAINER_NAME, "first");
  await Bun.sleep(250);
  podman(h).emitLog(CONTAINER_NAME, "second");
  await eventually(async () => stream.events.length - before === 2);
  expect(stream.events.slice(before).map((event) => (event.data as { lines: string[] }).lines)).toEqual([["first"], ["second"]]);
});


async function importEngine() {
  const runtime = new FakeRuntime({ versionOf: () => "2.7.0" });
  const h = start({ runtimes: { podman: runtime } });
  runtime.holdImage(IMAGE_2_7_0);
  h.engineStore.addLocal({ name: "This computer", token: "import-test-token", packageKind: "container", installedVersion: "2.7.0" });
  h.settings.set("local.package", { packageVersion: "2.7.0", variant: "linux-amd64-cpu", runtime: "podman", container: { kind: "container", image: "ghcr.io/aidronemap/aidm-api", digest: DIGEST_2_7_0, size: SIZE_2_7_0, gpu: false } });
  expect((await h.localEngine.start()).ok).toBe(true);
  const folder = mkdtempSync(join(os.tmpdir(), "aidm-import-mount-"));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  return { h, runtime, folder };
}

test("an idle local container restarts once to share an imported folder read-only", async () => {
  const { h, runtime, folder } = await importEngine();
  expect(h.localEngine.importPlan(folder).restartRequired).toBe(true);
  const before = runtime.starts.length;
  const result = await h.localEngine.prepareImport(folder);
  expect(result.ok).toBe(true);
  expect(runtime.starts).toHaveLength(before + 1);
  expect(runtime.starts.at(-1)!.spec.mounts).toContainEqual(expect.objectContaining({ hostPath: folder, readOnly: true }));
  expect(h.localEngine.importPlan(folder).restartRequired).toBe(false);
  expect((await h.localEngine.prepareImport(folder)).ok).toBe(true);
  expect(runtime.starts).toHaveLength(before + 1);
});

test.each(["reported", "recorded"] as const)("a %s active run prevents an import mount restart", async activity => {
  const { h, runtime, folder } = await importEngine();
  if (activity === "reported") runtime.engine(CONTAINER_NAME)!.info.taskQueueCount = 1;
  else h.runs.create({ engineId: h.engineStore.local()!.id, projectId: h.ctx.projects.create("Field", "").id, options: [] });
  const before = runtime.starts.length;
  expect(await h.localEngine.prepareImport(folder)).toMatchObject({ ok: false, error: { code: "local.busy" } });
  expect(runtime.starts).toHaveLength(before);
});


test("the sample cannot start while the local engine is reserving an import restart", async () => {
  const { h, runtime, folder } = await importEngine();
  runtime.engine(CONTAINER_NAME)!.infoDelayMs = 100;
  const sharing = h.localEngine.prepareImport(folder);
  await eventually(async () => !h.localEngine.acceptsRuns());
  expect(await h.sample.start(h.engineStore.local()!.id)).toMatchObject({ ok: false, status: 409, error: { code: "local.busy" } });
  expect((await sharing).ok).toBe(true);
  expect(h.localEngine.acceptsRuns()).toBe(true);
});
