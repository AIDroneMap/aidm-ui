import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { EngineView, RunLogView, RunView, SampleView } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { SAMPLE_JOB_PEAK_MEMORY } from "../machine/thresholds.ts";
import { TaskClient, type EngineEndpoint } from "../task-api/task-client.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";
import { SAMPLE_DATASET, type SampleDatasetEntry } from "./sample-dataset.ts";

const encoder = new TextEncoder();
const IMAGES = ["DJI_0001.JPG", "DJI_0002.JPG", "dji_0003.jpeg"];

let harness: Harness;
let fake: FakeTaskApi;
let files: FakeFileServer;
let scratch: string;
let zipBytes: Uint8Array;
let dataset: SampleDatasetEntry;

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** A small stored zip: three images, and a text file the sample job must ignore. */
function makeZip(names: string[], tag: string): Uint8Array {
  const path = join(scratch, `${tag}.zip`);
  writeStoredZip(path, [
    ...names.map((name, index) => ({ name, data: encoder.encode(`${tag}-image-${index}-`.repeat(10 + index)) })),
    { name: "README.txt", data: encoder.encode("not an image") },
  ]);
  return new Uint8Array(readFileSync(path));
}

function entryFor(bytes: Uint8Array, overrides: Partial<SampleDatasetEntry> = {}): SampleDatasetEntry {
  return {
    ...SAMPLE_DATASET,
    name: "test-dataset",
    url: files.url("/dataset.zip"),
    size: bytes.length,
    sha256: sha256(bytes),
    imageCount: IMAGES.length,
    fileName: "test-dataset.zip",
    ...overrides,
  };
}

beforeEach(async () => {
  scratch = mkdtempSync(join(os.tmpdir(), "aidm-ui-sample-test-"));
  zipBytes = makeZip(IMAGES, "good");
  files = new FakeFileServer({ "/dataset.zip": zipBytes });
  await files.start();
  dataset = entryFor(zipBytes);
  fake = new FakeTaskApi();
  await fake.start();
  harness = openHarness({ enginePollMs: 50, runPollMs: 30, sampleDataset: dataset, architecture: "x64" });
});

afterEach(async () => {
  await harness.stop();
  await fake.stop();
  await files.stop();
  rmSync(scratch, { recursive: true, force: true });
});

function send(method: string, path: string, body?: unknown, h: Harness = harness): Promise<Response> {
  return fetch(`${h.base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function getJson<T>(path: string, h: Harness = harness): Promise<T> {
  return (await (await send("GET", path, undefined, h)).json()) as T;
}

async function addEngine(name = "Office"): Promise<EngineView> {
  const response = await send("POST", "/api/engines", { name, address: fake.address, token: fake.token });
  expect(response.status).toBe(201);
  return (await response.json()) as EngineView;
}

async function startSample(engineId: number): Promise<Response> {
  return send("POST", "/api/sample/start", { engineId });
}

async function startedRun(engineId: number): Promise<RunView> {
  const response = await startSample(engineId);
  expect(response.status).toBe(202);
  return (await response.json()) as RunView;
}

async function waitRun(id: number, check: (run: RunView) => boolean, h: Harness = harness): Promise<RunView> {
  let last: RunView | undefined;
  await eventually(async () => {
    last = await getJson<RunView>(`/api/runs/${id}`, h);
    return check(last);
  });
  return last as RunView;
}

/** The only task on the fake. */
function theTask(): string {
  const [uuid] = [...fake.tasks.keys()];
  if (uuid === undefined) throw new Error("The fake has no task.");
  return uuid;
}

/** Starts the sample job on a new engine and waits until the engine has the task, queued. */
async function startAndQueue(): Promise<{ run: RunView; uuid: string; engine: EngineView }> {
  const engine = await addEngine();
  const run = await startedRun(engine.id);
  expect(run).toMatchObject({ name: "run.sample_name", preset: "map-with-heights", wayIn: "upload", sample: true });
  const queued = await waitRun(run.id, (candidate) => candidate.state === "queued");
  return { run: queued, uuid: theTask(), engine };
}

async function engineState(id: number): Promise<string | undefined> {
  return (await getJson<EngineView[]>("/api/engines")).find((engine) => engine.id === id)?.state;
}

/** Reads server-sent events one at a time. */
function eventReader(response: Response) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(
      check: (event: string, data: unknown) => boolean = () => true,
      timeoutMs = 3000,
    ): Promise<{ event: string; data: unknown }> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = block.split("\n").find((line) => line.startsWith("event: "));
          const data = block.split("\n").find((line) => line.startsWith("data: "));
          if (name !== undefined && data !== undefined) {
            const parsed = JSON.parse(data.slice("data: ".length)) as unknown;
            const event = name.slice("event: ".length);
            if (check(event, parsed)) return { event, data: parsed };
          }
          continue;
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("No matching event in time.");
        const chunk = await Promise.race([reader.read(), Bun.sleep(left).then(() => "timeout" as const)]);
        if (chunk === "timeout") throw new Error("No matching event in time.");
        if (chunk.done) throw new Error("The stream ended.");
        buffer += decoder.decode(chunk.value);
      }
    },
    close: () => reader.cancel(),
  };
}

// Criterion: the download starts only after the click, with the size shown first.

test("the size is shown first and nothing is downloaded until the operator starts the job", async () => {
  const engine = await addEngine();
  const view = await getJson<SampleView>("/api/sample");
  expect(view.dataset.size).toBe(zipBytes.length);
  expect(view.run).toBeNull();
  expect(view.engines).toEqual([
    { engineId: engine.id, engineName: "Office", local: false, offered: true, memoryCap: 64895025152, reason: null },
  ]);
  await Bun.sleep(150);
  expect(files.requests).toEqual([]);

  await startedRun(engine.id);
  await eventually(async () => files.requests.length > 0);
  expect(files.requests[0]).toMatchObject({ method: "GET", path: "/dataset.zip" });
});

test("starting answers at once with a run that is downloading", async () => {
  const engine = await addEngine();
  const response = await startSample(engine.id);
  expect(response.status).toBe(202);
  const run = (await response.json()) as RunView;
  expect(run).toMatchObject({
    state: "created",
    step: "download",
    download: { received: 0, total: zipBytes.length, speed: null, retries: 0, lastRetry: null },
    engineId: engine.id,
    engineName: "Office",
    engineLocal: false,
    resultsAvailable: false,
  });
  expect((await getJson<SampleView>("/api/sample")).run?.id).toBe(run.id);
});

test("a download that breaks reports its speed, how often it broke and why, like the engine's download", async () => {
  files.cutNextResponseAfter(10);
  const engine = await addEngine();
  const seen: NonNullable<RunView["download"]>[] = [];
  const run = await startedRun(engine.id);
  const unsubscribe = harness.tracker.subscribe(run.id, (event) => {
    if (event.type === "run" && event.run.download !== null) seen.push(event.run.download);
  });
  await waitRun(run.id, (candidate) => candidate.state === "queued");
  unsubscribe();

  expect(seen.some((download) => download.retries === 0 && download.speed === null)).toBe(true);
  const broken = seen.find((download) => download.retries === 1);
  expect(broken?.lastRetry).toEqual({ code: "download.connection_interrupted", data: {} });
  // The speed is measured over the last seconds, so it exists once the download has gone on for one.
  const last = seen.at(-1);
  expect(last).toMatchObject({ received: zipBytes.length, total: zipBytes.length, retries: 1 });
  expect(last?.speed).toBeGreaterThan(0);
  // Once the photos are on their way to the engine, the download is no longer shown.
  expect((await getJson<RunView>(`/api/runs/${run.id}`)).download).toBeNull();
});

// Criterion: init, upload per image, commit.

test("each image is uploaded with its own call, then the task is committed with the DSM option", async () => {
  const { run, uuid } = await startAndQueue();
  expect(fake.uploads).toEqual([
    { uuid, fileName: "DJI_0001.JPG", size: 10 * "good-image-0-".length },
    { uuid, fileName: "DJI_0002.JPG", size: 11 * "good-image-1-".length },
    { uuid, fileName: "dji_0003.jpeg", size: 12 * "good-image-2-".length },
  ]);
  expect(fake.tasks.get(uuid)).toMatchObject({
    name: "Sample job",
    options: [{ name: "dsm", value: true }],
    images: ["DJI_0001.JPG", "DJI_0002.JPG", "dji_0003.jpeg"],
    committed: true,
  });
  const paths = fake.requests.map((request) => `${request.method} ${request.path.replace(uuid, ":uuid")}`);
  expect(paths.filter((path) => path.startsWith("POST"))).toEqual([
    "POST /task/new/init",
    "POST /task/new/upload/:uuid",
    "POST /task/new/upload/:uuid",
    "POST /task/new/upload/:uuid",
    "POST /task/new/commit/:uuid",
  ]);
  expect(run.step).toBeNull();
  expect(run.upload).toBeNull();
});

test("the download and the upload show their progress while they run", async () => {
  fake.uploadDelayMs = 150;
  const engine = await addEngine();
  const run = await startedRun(engine.id);
  const uploading = await waitRun(run.id, (candidate) => candidate.step === "upload" && (candidate.upload?.done ?? 0) >= 1);
  expect(uploading.state).toBe("uploading");
  expect(uploading.upload?.total).toBe(3);
  expect(uploading.download).toBeNull();
});

// Criteria: queued, processing, completed, results.

test("the run follows the engine through queued, processing and completed, and offers the results", async () => {
  const { run, uuid } = await startAndQueue();
  expect(run.resultsAvailable).toBe(false);

  // The real API says RUNNING with a processing time of -1 while it reads the images.
  fake.setTask(uuid, { statusCode: 20, processingTime: -1 });
  await Bun.sleep(100);
  expect((await getJson<RunView>(`/api/runs/${run.id}`)).state).toBe("queued");

  fake.setTask(uuid, { statusCode: 20, processingTime: 4000, progress: 37.5 });
  const processing = await waitRun(run.id, (candidate) => candidate.state === "processing");
  expect(processing.progress).toBe(37.5);
  expect((await send("GET", `/api/runs/${run.id}/results`)).status).toBe(409);

  const results = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8]);
  fake.setTask(uuid, { statusCode: 40, processingTime: 90_000, progress: 100, results });
  const completed = await waitRun(run.id, (candidate) => candidate.state === "completed");
  expect(completed).toMatchObject({ progress: 100, resultsAvailable: true, step: null });

  const download = await send("GET", `/api/runs/${run.id}/results`);
  expect(download.status).toBe(200);
  expect(download.headers.get("content-type")).toBe("application/zip");
  expect(download.headers.get("content-disposition")).toBe('attachment; filename="sample-job-results.zip"');
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(results);
});

test("a finished run on a remote engine leaves one summary in aidm-ui's log, from the output it received", async () => {
  const { run, uuid } = await startAndQueue();
  fake.setTask(uuid, { statusCode: 20, processingTime: 4000, output: ["[INFO]    Running dataset stage", "[WARNING] Cannot write benchmark file"] });
  await waitRun(run.id, (candidate) => candidate.state === "processing");
  await Bun.sleep(80);
  fake.setTask(uuid, {
    statusCode: 40,
    processingTime: 395_250,
    progress: 100,
    output: ["[INFO]    Running dataset stage", "[WARNING] Cannot write benchmark file", "[INFO]    Running opensfm stage", "[WARNING] PoissonRecon failed with 8 threads, let's retry with 4..."],
  });
  await waitRun(run.id, (candidate) => candidate.state === "completed");
  const lines = harness.logs.filter((line) => line.startsWith(`Run ${run.id} summary:`));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(new RegExp(`^Run ${run.id} summary: completed on "Office"; the engine took 395.3 s; stages \\(as AIDM UI's polls saw them, to within a poll\\): dataset [\\d.]+ s, opensfm [\\d.]+ s; 2 warnings; failed processes not known from the output; the engine's task log: on the engine, in the folder of task ${uuid} `));
});

test("a failed run passes the engine's own message through", async () => {
  const { run, uuid } = await startAndQueue();
  fake.setTask(uuid, { statusCode: 30, errorMessage: "Not enough memory", progress: 12 });
  const failed = await waitRun(run.id, (candidate) => candidate.state === "failed");
  expect(failed).toMatchObject({ engineMessage: "Not enough memory", progress: 12, resultsAvailable: false });
});

test("the console lines arrive on the events stream and through the log route", async () => {
  const { run, uuid } = await startAndQueue();
  const events = eventReader(await send("GET", `/api/runs/${run.id}/events`));
  try {
    const first = await events.next((event) => event === "run");
    expect(first.data).toMatchObject({ id: run.id, state: "queued" });
    expect((await events.next((event) => event === "log")).data).toEqual({ lines: [], from: 0 });

    fake.setTask(uuid, { statusCode: 20, processingTime: 1000, output: ["Reading images", "Matching"] });
    const lines = await events.next((event, data) => event === "log" && (data as { lines: string[] }).lines.length > 0);
    expect(lines.data).toEqual({ lines: ["Reading images", "Matching"], from: 0 });
    await events.next((event, data) => event === "run" && (data as RunView).state === "processing");

    fake.setTask(uuid, { output: ["Reading images", "Matching", "Meshing"] });
    expect((await events.next((event) => event === "log")).data).toEqual({ lines: ["Meshing"], from: 2 });
  } finally {
    await events.close();
  }
  expect(await getJson<RunLogView>(`/api/runs/${run.id}/log`)).toEqual({
    lines: ["Reading images", "Matching", "Meshing"],
    next: 3,
    restartedAtLine: null,
  });
  expect(await getJson<RunLogView>(`/api/runs/${run.id}/log?from=2`)).toEqual({
    lines: ["Meshing"],
    next: 3,
    restartedAtLine: null,
  });
  expect(readFileSync(join(harness.dataFolder, "runs", String(run.id), "log.txt"), "utf8")).toBe(
    "Reading images\nMatching\nMeshing\n",
  );
});

test("a listener that joins late gets the lines saved so far", async () => {
  const { run, uuid } = await startAndQueue();
  fake.setTask(uuid, { statusCode: 20, processingTime: 1000, output: ["one", "two"] });
  await eventually(async () => (await getJson<RunLogView>(`/api/runs/${run.id}/log`)).next === 2);
  const events = eventReader(await send("GET", `/api/runs/${run.id}/events`));
  try {
    expect((await events.next((event) => event === "log")).data).toEqual({ lines: ["one", "two"], from: 0 });
  } finally {
    await events.close();
  }
});

test("the engine's results are not offered when the engine says they are not ready", async () => {
  const { run, uuid } = await startAndQueue();
  fake.setTask(uuid, { statusCode: 40, progress: 100, results: null });
  await waitRun(run.id, (candidate) => candidate.state === "completed");
  const response = await send("GET", `/api/runs/${run.id}/results`);
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: { code: "engine.error", data: { message: "Asset not ready" } } });
});

// Criterion: cancel during upload or processing leaves the engine ready.

test("cancelling during the upload removes the task and leaves the engine ready", async () => {
  fake.uploadDelayMs = 10_000;
  const engine = await addEngine();
  const run = await startedRun(engine.id);
  await waitRun(run.id, (candidate) => candidate.state === "uploading");
  await eventually(async () => fake.requests.some((request) => request.path.startsWith("/task/new/upload/")));

  const response = await send("POST", `/api/runs/${run.id}/cancel`);
  expect(response.status).toBe(200);
  expect(((await response.json()) as RunView).state).toBe("cancelled");

  expect(fake.requests.some((request) => request.method === "POST" && request.path === "/task/remove")).toBe(true);
  expect(fake.tasks.size).toBe(0);
  await eventually(async () => (await engineState(engine.id)) === "ready");
  expect((await getJson<RunView>(`/api/runs/${run.id}`)).state).toBe("cancelled");
});

test("cancelling during processing cancels the task and leaves the engine ready", async () => {
  const { run, uuid, engine } = await startAndQueue();
  fake.setTask(uuid, { statusCode: 20, processingTime: 3000, progress: 20 });
  await waitRun(run.id, (candidate) => candidate.state === "processing");
  await eventually(async () => (await engineState(engine.id)) === "busy");

  const response = await send("POST", `/api/runs/${run.id}/cancel`);
  expect(response.status).toBe(200);
  expect(((await response.json()) as RunView).state).toBe("cancelled");
  expect(fake.requests.some((request) => request.method === "POST" && request.path === "/task/cancel")).toBe(true);
  expect(fake.tasks.get(uuid)?.statusCode).toBe(50);

  await eventually(async () => (await engineState(engine.id)) === "ready");
  // The tracker no longer polls it, so a late answer from the engine cannot undo the cancel.
  await Bun.sleep(100);
  expect((await getJson<RunView>(`/api/runs/${run.id}`)).state).toBe("cancelled");
});

test("a finished run cannot be cancelled and an unknown run is not found", async () => {
  const { run, uuid } = await startAndQueue();
  fake.setTask(uuid, { statusCode: 40, results: new Uint8Array([1]) });
  await waitRun(run.id, (candidate) => candidate.state === "completed");
  const again = await send("POST", `/api/runs/${run.id}/cancel`);
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: { code: "run.not_cancellable", data: {} } });

  const unknown = await send("POST", "/api/runs/999/cancel");
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: { code: "run.not_found", data: {} } });
});

test("a second start while a run is going is refused, and allowed again once it ended", async () => {
  const { run, engine } = await startAndQueue();
  const refused = await startSample(engine.id);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: { code: "sample.already_running", data: {} } });
  expect(fake.tasks.size).toBe(1);

  await send("POST", `/api/runs/${run.id}/cancel`);
  const next = await startedRun(engine.id);
  expect(next.id).not.toBe(run.id);
});

// Criterion: unknown status code.

test("an unknown status code shows as unknown and is logged once with its raw value", async () => {
  const { run, uuid } = await startAndQueue();
  fake.setTask(uuid, { statusCode: 99 });
  const unknown = await waitRun(run.id, (candidate) => candidate.state === "unknown");
  expect(unknown.resultsAvailable).toBe(false);
  await Bun.sleep(150);
  const lines = harness.logs.filter((line) => line.includes("unknown status code"));
  expect(lines).toEqual([`Run ${run.id}: the engine sent an unknown status code: 99`]);

  // The run goes on being followed, so a known code puts it right again.
  fake.setTask(uuid, { statusCode: 20, processingTime: 500 });
  await waitRun(run.id, (candidate) => candidate.state === "processing");
});

// Criterion: the page's numbers come from the pinned entry and the measured reference.

test("the numbers are the pinned entry's and the measured reference's, nothing computed here", async () => {
  await harness.stop();
  harness = openHarness({ architecture: "x64" });
  const view = await getJson<SampleView>("/api/sample");
  expect(view.dataset).toEqual({
    name: SAMPLE_DATASET.name,
    licence: "CC BY 4.0",
    licenceUrl: SAMPLE_DATASET.licenceUrl,
    attribution: SAMPLE_DATASET.attribution,
    imageCount: 73,
    size: 888_735_308,
  });
  expect(view.reference).toEqual({ architecture: "x86-64", seconds: 1366, cores: 4, memoryGiB: 15 });
  expect(view.peakMemory).toBe(SAMPLE_JOB_PEAK_MEMORY);
  expect(view.engines).toEqual([]);
});

test("on arm64 the arm64 reference is shown, and a machine without a measurement gets none", async () => {
  await harness.stop();
  harness = openHarness({ architecture: "arm64" });
  expect((await getJson<SampleView>("/api/sample")).reference).toEqual({
    architecture: "arm64",
    seconds: 982,
    cores: 4,
    memoryGiB: 15,
  });
  await harness.stop();
  harness = openHarness({ architecture: "riscv64" });
  expect((await getJson<SampleView>("/api/sample")).reference).toBeNull();
});

// Criterion: the memory rule.

test("an engine with less memory than the sample job's peak is not offered, and more memory offers it", async () => {
  fake.info.totalMemory = SAMPLE_JOB_PEAK_MEMORY - 1;
  const engine = await addEngine();
  const below = (await getJson<SampleView>("/api/sample")).engines[0];
  expect(below).toEqual({
    engineId: engine.id,
    engineName: "Office",
    local: false,
    offered: false,
    memoryCap: SAMPLE_JOB_PEAK_MEMORY - 1,
    reason: { code: "sample.memory_below_peak", data: { cap: SAMPLE_JOB_PEAK_MEMORY - 1, peak: SAMPLE_JOB_PEAK_MEMORY } },
  });

  const refused = await startSample(engine.id);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: below?.reason });
  expect(files.requests).toEqual([]);

  fake.info.totalMemory = SAMPLE_JOB_PEAK_MEMORY + 1;
  await eventually(async () => (await getJson<SampleView>("/api/sample")).engines[0]?.offered === true);
  expect((await getJson<SampleView>("/api/sample")).engines[0]).toMatchObject({
    offered: true,
    memoryCap: SAMPLE_JOB_PEAK_MEMORY + 1,
    reason: null,
  });
});

test("an engine that reports no memory, or is switched off, or does not exist is not offered", async () => {
  fake.info.totalMemory = "lots";
  const engine = await addEngine();
  expect((await getJson<SampleView>("/api/sample")).engines[0]).toMatchObject({
    offered: false,
    memoryCap: null,
    reason: { code: "sample.memory_unknown", data: {} },
  });

  fake.info.totalMemory = SAMPLE_JOB_PEAK_MEMORY * 2;
  await eventually(async () => (await getJson<SampleView>("/api/sample")).engines[0]?.offered === true);
  await send("PUT", `/api/engines/${engine.id}`, { enabled: false });
  expect((await getJson<SampleView>("/api/sample")).engines[0]).toMatchObject({
    offered: false,
    reason: { code: "sample.engine_not_usable", data: {} },
  });
  const refused = await startSample(engine.id);
  expect(refused.status).toBe(409);

  const missing = await startSample(999);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: { code: "engine.not_found", data: {} } });
  const bad = await send("POST", "/api/sample/start", { engineId: "1" });
  expect(bad.status).toBe(400);
});

// Criterion: the dataset is checked, and problems end the run with a code.

test("a corrupted dataset ends the run failed with a checksum code, and nothing reaches the engine", async () => {
  const corrupted = new Uint8Array(zipBytes);
  corrupted[corrupted.length >> 1] = (corrupted[corrupted.length >> 1] ?? 0) ^ 0xff;
  files.files.set("/dataset.zip", corrupted);
  const engine = await addEngine();
  const run = await startedRun(engine.id);
  const failed = await waitRun(run.id, (candidate) => candidate.state === "failed");
  expect(failed.problem).toEqual({ code: "download.checksum_mismatch", data: expect.anything() });
  expect(fake.tasks.size).toBe(0);
  expect(fake.uploads).toEqual([]);

  // The failed run does not block a new one.
  files.files.set("/dataset.zip", zipBytes);
  const again = await startedRun(engine.id);
  await waitRun(again.id, (candidate) => candidate.state === "queued");
});

test("a dataset with the wrong number of images ends the run failed with the counts", async () => {
  const short = makeZip(["a.JPG", "b.JPG"], "short");
  files.files.set("/dataset.zip", short);
  await harness.stop();
  harness = openHarness({ enginePollMs: 50, runPollMs: 30, sampleDataset: entryFor(short, { imageCount: 3 }) });
  const engine = await addEngine();
  const run = await startedRun(engine.id);
  const failed = await waitRun(run.id, (candidate) => candidate.state === "failed");
  expect(failed.problem).toEqual({ code: "sample.dataset_invalid", data: { expected: 3, found: 2 } });
  expect(fake.tasks.size).toBe(0);
});

test("not enough free space ends the run failed before any download", async () => {
  await harness.stop();
  harness = openHarness({ enginePollMs: 50, runPollMs: 30, sampleDataset: dataset, freeBytes: () => 10 });
  const engine = await addEngine();
  const run = await startedRun(engine.id);
  const failed = await waitRun(run.id, (candidate) => candidate.state === "failed");
  expect(failed.problem?.code).toBe("download.not_enough_space");
  expect(files.requests).toEqual([]);
});

test("an engine that answers with an error ends the run with its message", async () => {
  const engine = await addEngine();
  // The token changes after the engine was added, so the engine now answers every call with an error.
  fake.token = "changed";
  const run = await startedRun(engine.id);
  const failed = await waitRun(run.id, (candidate) => candidate.state === "failed");
  expect(failed.problem?.code).toBe("run.engine_refused");
  expect(failed.problem?.data).toHaveProperty("message");
  expect(fake.tasks.size).toBe(0);
  expect(fake.uploads).toEqual([]);
});

test("an engine that goes away during the upload ends the run failed with an upload problem", async () => {
  fake.uploadDelayMs = 200;
  const engine = await addEngine();
  const run = await startedRun(engine.id);
  await waitRun(run.id, (candidate) => candidate.state === "uploading");
  await fake.stop();
  const failed = await waitRun(run.id, (candidate) => candidate.state === "failed");
  expect(failed.problem).toEqual({ code: "run.upload_failed", data: {} });
  await fake.start(Number(new URL(fake.address).port));
});

// The engine going away while a run is processing, and aidm-ui restarting.

test("three missed polls in a row show the engine as unreachable, and the next answer puts the state back", async () => {
  const { run, uuid } = await startAndQueue();
  fake.setTask(uuid, { statusCode: 20, processingTime: 2000 });
  await waitRun(run.id, (candidate) => candidate.state === "processing");
  await fake.stop();
  await waitRun(run.id, (candidate) => candidate.state === "engine_unreachable");
  await fake.restart();
  await waitRun(run.id, (candidate) => candidate.state === "processing");
});

test("after aidm-ui restarts it goes on following a processing run without repeating log lines", async () => {
  const dataFolder = mkdtempSync(join(os.tmpdir(), "aidm-ui-restart-test-"));
  await harness.stop();
  let first: Harness | undefined;
  let second: Harness | undefined;
  try {
    const options = { enginePollMs: 50, runPollMs: 30, sampleDataset: dataset, dataFolder };
    first = openHarness(options);
    harness = first;
    const engine = await addEngine();
    const run = await startedRun(engine.id);
    await waitRun(run.id, (candidate) => candidate.state === "queued", first);
    const uuid = theTask();
    fake.setTask(uuid, { statusCode: 20, processingTime: 1000, progress: 10, output: ["a", "b"] });
    await waitRun(run.id, (candidate) => candidate.state === "processing", first);
    await eventually(async () => (await getJson<RunLogView>(`/api/runs/${run.id}/log`, first)).next === 2);
    await first.stop();
    first = undefined;

    second = openHarness(options);
    harness = second;
    const resumed = await getJson<RunView>(`/api/runs/${run.id}`, second);
    expect(resumed.state).toBe("processing");
    fake.setTask(uuid, { output: ["a", "b", "c"], progress: 55 });
    await waitRun(run.id, (candidate) => candidate.progress === 55, second);
    expect((await getJson<RunLogView>(`/api/runs/${run.id}/log`, second)).lines).toEqual(["a", "b", "c"]);

    fake.setTask(uuid, { statusCode: 40, progress: 100, results: new Uint8Array([9, 9]) });
    const done = await waitRun(run.id, (candidate) => candidate.state === "completed", second);
    expect(done.resultsAvailable).toBe(true);
    expect((await getJson<SampleView>("/api/sample", second)).run?.id).toBe(run.id);
  } finally {
    await first?.stop();
    await second?.stop();
    harness = openHarness();
    rmSync(dataFolder, { recursive: true, force: true });
  }
});

test("a run that was still being prepared when aidm-ui stopped is failed on the next start", async () => {
  const dataFolder = mkdtempSync(join(os.tmpdir(), "aidm-ui-restart-test-"));
  await harness.stop();
  let first: Harness | undefined;
  let second: Harness | undefined;
  try {
    first = openHarness({ sampleDataset: dataset, dataFolder });
    harness = first;
    const engine = await addEngine();
    // What a crash would leave behind: a run that never got past the upload.
    const run = first.runs.create({ projectId: first.runs.builtinProjectId("sample") as number, engineId: engine.id, options: [] });
    first.runs.update(run.id, { state: "uploading", taskUuid: "lost" });
    await first.stop();
    first = undefined;

    second = openHarness({ sampleDataset: dataset, dataFolder });
    harness = second;
    const failed = await getJson<RunView>(`/api/runs/${run.id}`, second);
    expect(failed.state).toBe("failed");
    expect(failed.problem).toEqual({ code: "run.interrupted", data: {} });
    // It does not block a new start. After a restart an engine is usable only once it has
    // answered a poll. The test asks for that poll itself, so no timer decides whether the
    // start comes before the first answer (it did once in CI, and the start got 409).
    await second.engines.pollNow(engine.id);
    expect(second.engines.isUsable(engine.id)).toBe(true);
    expect((await send("POST", "/api/sample/start", { engineId: engine.id }, second)).status).toBe(202);
  } finally {
    await first?.stop();
    await second?.stop();
    harness = openHarness();
    rmSync(dataFolder, { recursive: true, force: true });
  }
});

// Unknown runs.

test("every run route answers 404 with a code for a run that does not exist", async () => {
  for (const path of ["/api/runs/999", "/api/runs/999/log", "/api/runs/999/events", "/api/runs/999/results", "/api/runs/x"]) {
    const response = await send("GET", path);
    expect(response.status, path).toBe(404);
    expect(await response.json(), path).toEqual({ error: { code: "run.not_found", data: {} } });
  }
});

// A finished run never changes again.

test("an engine that finishes while a cancel is on its way keeps its result", async () => {
  const { run, uuid } = await startAndQueue();
  fake.setTask(uuid, { statusCode: 20, processingTime: 3000, progress: 20 });
  await waitRun(run.id, (candidate) => candidate.state === "processing");
  fake.cancelDelayMs = 500;
  const cancelling = send("POST", `/api/runs/${run.id}/cancel`);
  await eventually(async () => fake.requests.some((request) => request.path === "/task/cancel"));

  fake.setTask(uuid, { statusCode: 40, progress: 100, results: new Uint8Array([1, 2, 3]) });
  await waitRun(run.id, (candidate) => candidate.state === "completed");
  const answer = await cancelling;
  expect(answer.status).toBe(409);
  expect(await answer.json()).toEqual({ error: { code: "run.not_cancellable", data: {} } });

  await Bun.sleep(100);
  const final = await getJson<RunView>(`/api/runs/${run.id}`);
  expect(final).toMatchObject({ state: "completed", resultsAvailable: true, problem: null });
});

// A run on an engine that is gone.

test("a run whose engine was removed can still be cancelled", async () => {
  const { run, uuid, engine } = await startAndQueue();
  fake.setTask(uuid, { statusCode: 20, processingTime: 2000 });
  await waitRun(run.id, (candidate) => candidate.state === "processing");
  expect((await send("DELETE", `/api/engines/${engine.id}`)).status).toBe(204);

  const response = await send("POST", `/api/runs/${run.id}/cancel`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    state: "cancelled",
    problem: { code: "run.cancelled_without_engine", data: {} },
  });
  expect(fake.requests.some((request) => request.path === "/task/cancel")).toBe(false);
});

test("a run whose engine does not answer to the cancel ends cancelled and is no longer followed", async () => {
  const { run, uuid } = await startAndQueue();
  fake.setTask(uuid, { statusCode: 20, processingTime: 2000 });
  await waitRun(run.id, (candidate) => candidate.state === "processing");
  await fake.stop();

  const response = await send("POST", `/api/runs/${run.id}/cancel`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    state: "cancelled",
    problem: { code: "run.cancelled_without_engine", data: {} },
  });

  // The engine comes back and finishes the work, but this run has ended.
  await fake.restart();
  fake.setTask(uuid, { statusCode: 40, results: new Uint8Array([1]) });
  await Bun.sleep(200);
  expect(await getJson<RunView>(`/api/runs/${run.id}`)).toMatchObject({
    state: "cancelled",
    problem: { code: "run.cancelled_without_engine" },
    resultsAvailable: false,
  });
});

test("a task the engine no longer knows, three polls in a row, ends the run failed", async () => {
  const { run, uuid } = await startAndQueue();
  fake.setTask(uuid, { statusCode: 20, processingTime: 2000 });
  await waitRun(run.id, (candidate) => candidate.state === "processing");
  fake.tasks.delete(uuid);
  const lost = await waitRun(run.id, (candidate) => candidate.state === "failed");
  expect(lost.problem).toEqual({ code: "run.engine_lost", data: {} });
  expect(lost.resultsAvailable).toBe(false);
});

// No task is left behind on the engine.

function failingClient(change: (client: TaskClient) => void): (endpoint: EngineEndpoint) => TaskClient {
  return (endpoint) => {
    const client = new TaskClient(endpoint);
    change(client);
    return client;
  };
}

test("anything that throws after the task was created removes the task and fails the run", async () => {
  await harness.stop();
  harness = openHarness({
    enginePollMs: 50,
    runPollMs: 30,
    sampleDataset: dataset,
    runClientFor: failingClient((client) => {
      client.uploadImage = async () => {
        throw new Error("The disk went away.");
      };
    }),
  });
  const engine = await addEngine();
  const run = await startedRun(engine.id);
  const failed = await waitRun(run.id, (candidate) => candidate.state === "failed");
  expect(failed.problem).toEqual({ code: "server.internal_error", data: {} });
  expect(fake.requests.some((request) => request.method === "POST" && request.path === "/task/remove")).toBe(true);
  expect(fake.tasks.size).toBe(0);
});

test("a task that cannot be removed is logged with the run's number and without the token", async () => {
  await harness.stop();
  harness = openHarness({
    enginePollMs: 50,
    runPollMs: 30,
    sampleDataset: dataset,
    runClientFor: failingClient((client) => {
      client.uploadImage = async () => {
        throw new Error("The disk went away.");
      };
      client.removeTask = async () => ({ ok: false, failure: { kind: "unreachable", detail: "cut" } });
    }),
  });
  const engine = await addEngine();
  const run = await startedRun(engine.id);
  await waitRun(run.id, (candidate) => candidate.state === "failed");
  expect(harness.logs).toContain(`Run ${run.id}: the engine task could not be removed.`);
  expect(harness.logs.join("\n")).not.toContain(fake.token);
});

test("a cancel that the engine does not take after the commit keeps the run followed and says why", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await harness.stop();
  harness = openHarness({
    enginePollMs: 50,
    runPollMs: 30,
    sampleDataset: dataset,
    runClientFor: failingClient((client) => {
      const commit = client.commitTask.bind(client);
      client.commitTask = async (uuid, signal) => {
        const result = await commit(uuid, signal);
        await gate;
        return result;
      };
      client.cancelTask = async () => ({ ok: false, failure: { kind: "unreachable", detail: "cut" } });
    }),
  });
  const engine = await addEngine();
  const run = await startedRun(engine.id);
  await eventually(async () => [...fake.tasks.values()].some((task) => task.committed));

  const cancelling = send("POST", `/api/runs/${run.id}/cancel`);
  await Bun.sleep(100);
  release();
  const answer = await cancelling;
  expect(answer.status).toBe(502);
  expect(await answer.json()).toEqual({ error: { code: "engine.unreachable", data: {} } });

  // The run is not cancelled: it goes on being followed and ends with the engine's answer.
  const queued = await waitRun(run.id, (candidate) => candidate.state === "queued");
  expect(queued.problem).toBeNull();
  fake.setTask(theTask(), { statusCode: 40, progress: 100, results: new Uint8Array([1]) });
  await waitRun(run.id, (candidate) => candidate.state === "completed");
});

// Cancel acts at once.

test("cancelling during the download ends the run at once and keeps the part", async () => {
  files.stallNextResponseAfter(100);
  const engine = await addEngine();
  const run = await startedRun(engine.id);
  const part = join(harness.dataFolder, "downloads", "test-dataset.zip.part");
  await eventually(async () => existsSync(part) && statSync(part).size >= 100);

  const began = Date.now();
  const response = await send("POST", `/api/runs/${run.id}/cancel`);
  expect(response.status).toBe(200);
  expect(((await response.json()) as RunView).state).toBe("cancelled");
  expect(Date.now() - began).toBeLessThan(1000);
  expect(statSync(part).size).toBe(100);
  expect(fake.tasks.size).toBe(0);
});

// The log is bounded.

test("the log route gives at most 1000 lines from where it is asked, and the events stream replays the last 500", async () => {
  const { run, uuid } = await startAndQueue();
  const lines = Array.from({ length: 2300 }, (_, index) => `line ${index}`);
  fake.setTask(uuid, { statusCode: 20, processingTime: 1000, output: lines });
  await eventually(async () => (await getJson<RunLogView>(`/api/runs/${run.id}/log?from=2299`)).lines.length === 1);

  const first = await getJson<RunLogView>(`/api/runs/${run.id}/log`);
  expect(first.lines).toEqual(lines.slice(0, 1000));
  expect(first.next).toBe(1000);
  const second = await getJson<RunLogView>(`/api/runs/${run.id}/log?from=${first.next}`);
  expect(second.lines).toEqual(lines.slice(1000, 2000));
  expect(second.next).toBe(2000);
  const third = await getJson<RunLogView>(`/api/runs/${run.id}/log?from=${second.next}`);
  expect(third).toEqual({ lines: lines.slice(2000), next: 2300, restartedAtLine: null });
  expect(await getJson<RunLogView>(`/api/runs/${run.id}/log?from=2300`)).toEqual({ lines: [], next: 2300, restartedAtLine: null });
  expect(await getJson<RunLogView>(`/api/runs/${run.id}/log?from=99999`)).toEqual({ lines: [], next: 2300, restartedAtLine: null });

  const events = eventReader(await send("GET", `/api/runs/${run.id}/events`));
  try {
    const replay = await events.next((event) => event === "log");
    expect(replay.data).toEqual({ lines: lines.slice(1800), from: 1800 });
  } finally {
    await events.close();
  }
});

// The token stays out of every log.

test("the engine's token is in no log, stream or line of the server's own log during a sample job", async () => {
  const token = "SECRET-RUN-TOKEN";
  fake.token = token;
  const { run, uuid } = await startAndQueue();

  // A stretch without the engine puts failure lines into the server's log, with the engine's address in them.
  await fake.stop();
  await waitRun(run.id, (candidate) => candidate.state === "engine_unreachable");
  await fake.restart();
  fake.setTask(uuid, {
    statusCode: 20,
    processingTime: 1000,
    output: [`calling /info?token=${token}`, `token ${encodeURIComponent(token)} again`],
  });
  await eventually(async () => (await getJson<RunLogView>(`/api/runs/${run.id}/log`)).lines.length === 2);

  const seen: string[] = [];
  const events = eventReader(await send("GET", `/api/runs/${run.id}/events`));
  try {
    seen.push(JSON.stringify((await events.next((event) => event === "run")).data));
    seen.push(JSON.stringify((await events.next((event) => event === "log")).data));
  } finally {
    await events.close();
  }
  fake.setTask(uuid, { statusCode: 40, progress: 100, results: new Uint8Array([1]) });
  await waitRun(run.id, (candidate) => candidate.state === "completed");

  seen.push(readFileSync(join(harness.dataFolder, "runs", String(run.id), "log.txt"), "utf8"));
  seen.push(JSON.stringify(await getJson<RunLogView>(`/api/runs/${run.id}/log`)));
  seen.push(JSON.stringify(await getJson<RunView>(`/api/runs/${run.id}`)));
  seen.push(harness.logs.join("\n"));
  expect(harness.logs.length).toBeGreaterThan(0);
  for (const text of seen) {
    expect(text).not.toContain(token);
    expect(text).not.toContain(encodeURIComponent(token));
  }
  expect(seen[2]).toContain("calling /info?token=***");
});
