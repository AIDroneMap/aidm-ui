import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { EngineView, RunView, SampleDatasetFileView } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";
import { SAMPLE_DATASET, type SampleDatasetEntry } from "./sample-dataset.ts";

const IMAGES = ["DJI_0001.JPG", "DJI_0002.JPG", "dji_0003.jpeg"];

let scratch: string;
let zipBytes: Uint8Array<ArrayBuffer>;
let dataset: SampleDatasetEntry;
let files: FakeFileServer;
let fake: FakeTaskApi;
let harness: Harness;

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function entryFor(bytes: Uint8Array): SampleDatasetEntry {
  return {
    ...SAMPLE_DATASET,
    name: "test-dataset",
    url: files.url("/dataset.zip"),
    size: bytes.length,
    sha256: sha256(bytes),
    imageCount: IMAGES.length,
    fileName: "test-dataset.zip",
  };
}

beforeEach(async () => {
  scratch = mkdtempSync(join(os.tmpdir(), "aidm-ui-dataset-file-test-"));
  const path = join(scratch, "good.zip");
  writeStoredZip(path, IMAGES.map((name, index) => ({ name, data: new TextEncoder().encode(`image-${index}-`.repeat(20 + index)) })));
  zipBytes = new Uint8Array(readFileSync(path));
  files = new FakeFileServer({ "/dataset.zip": zipBytes });
  await files.start();
  fake = new FakeTaskApi();
  await fake.start();
  dataset = entryFor(zipBytes);
  harness = openHarness({ enginePollMs: 50, runPollMs: 30, sampleDataset: dataset, architecture: "x64" });
});

afterEach(async () => {
  await harness.stop();
  await fake.stop();
  await files.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const downloads = () => join(harness.dataFolder, "downloads");
const zipPath = () => join(downloads(), dataset.fileName);
const leftovers = () => (existsSync(downloads()) ? readdirSync(downloads()).filter((name) => name !== dataset.fileName) : []);

function send(method: string, path: string, body?: BodyInit): Promise<Response> {
  return fetch(`${harness.base}${path}`, { method, body });
}

async function errorOf(response: Response): Promise<ApiError> {
  return ((await response.json()) as { error: ApiError }).error;
}

/** A body that reaches the server without a Content-Length: it is sent in chunks. */
function chunked(bytes: Uint8Array, chunkSize = 16): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(at, at + chunkSize));
      at += chunkSize;
    },
  });
}

async function addEngine(): Promise<EngineView> {
  const response = await send("POST", "/api/engines", JSON.stringify({ name: "Office", address: fake.address, token: fake.token }));
  expect(response.status).toBe(201);
  return (await response.json()) as EngineView;
}

test("with no zip kept, the dataset route says so", async () => {
  const response = await send("GET", "/api/sample/dataset");
  expect(response.status).toBe(200);
  expect((await response.json()) as SampleDatasetFileView).toEqual({ present: false, size: null, fileName: "test-dataset.zip" });
});

test("a good import is kept with its size, and the next run uses it without any download", async () => {
  const response = await send("POST", "/api/sample/dataset", zipBytes as Uint8Array<ArrayBuffer>);
  expect(response.status).toBe(200);
  expect((await response.json()) as SampleDatasetFileView).toEqual({ present: true, size: zipBytes.length, fileName: "test-dataset.zip" });
  expect(new Uint8Array(readFileSync(zipPath()))).toEqual(zipBytes);
  expect(leftovers()).toEqual([]);
  expect(((await (await send("GET", "/api/sample/dataset")).json()) as SampleDatasetFileView).present).toBe(true);

  const engine = await addEngine();
  const started = await send("POST", "/api/sample/start", JSON.stringify({ engineId: engine.id }));
  expect(started.status).toBe(202);
  const run = (await started.json()) as RunView;
  await eventually(async () => ((await (await send("GET", `/api/runs/${run.id}`)).json()) as RunView).state === "queued");
  expect(files.requests).toEqual([]);
  expect(fake.uploads).toHaveLength(IMAGES.length);
});

test("a body sent in chunks, with no Content-Length, is imported the same way", async () => {
  const response = await send("POST", "/api/sample/dataset", chunked(zipBytes) as unknown as BodyInit);
  expect(response.status).toBe(200);
  expect(new Uint8Array(readFileSync(zipPath()))).toEqual(zipBytes);
  expect(leftovers()).toEqual([]);
});

test("a body larger than 1 MiB is accepted by the import and by no other route", async () => {
  await harness.stop();
  const big = new Uint8Array(1.5 * 1024 ** 2).map((_, index) => index % 251);
  harness = openHarness({ sampleDataset: entryFor(big) });
  const response = await send("POST", "/api/sample/dataset", big as Uint8Array<ArrayBuffer>);
  expect(response.status).toBe(200);
  expect(new Uint8Array(readFileSync(zipPath()))).toEqual(big);

  // The declared length is refused with a code, whatever the route.
  const declared = await send("PUT", "/api/settings/port", "x".repeat(1024 ** 2 + 1));
  expect(declared.status).toBe(413);
  expect(await errorOf(declared)).toEqual({ code: "api.body_too_large", data: {} });
  // A body without a declared length is cut off as it is read.
  const streamed = await send("PUT", "/api/settings/port", chunked(new Uint8Array(1024 ** 2 + 1), 64 * 1024) as unknown as BodyInit);
  expect(streamed.status).toBe(413);
  expect(await errorOf(streamed)).toEqual({ code: "api.body_too_large", data: {} });
  // The import is the one route that takes a zip: the others still read small JSON.
  expect((await send("PUT", "/api/settings/port", JSON.stringify({ port: null }))).status).toBe(200);
});

test("a file with the right size and another checksum is refused and leaves nothing behind", async () => {
  const wrong = new Uint8Array(zipBytes);
  wrong[wrong.length - 1] = (wrong[wrong.length - 1] ?? 0) ^ 0xff;
  const response = await send("POST", "/api/sample/dataset", wrong as Uint8Array<ArrayBuffer>);
  expect(response.status).toBe(400);
  expect(await errorOf(response)).toEqual({ code: "sample.import_mismatch", data: {} });
  expect(existsSync(zipPath())).toBe(false);
  expect(leftovers()).toEqual([]);
});

test("a file of another size is refused, whether the length is declared or only counted, and leaves nothing behind", async () => {
  const short = zipBytes.subarray(0, zipBytes.length - 1);
  const long = new Uint8Array([...zipBytes, 0]);
  for (const [name, body, found] of [
    ["short", short as Uint8Array<ArrayBuffer>, short.length],
    ["long", long as Uint8Array<ArrayBuffer>, long.length],
    ["short, chunked", chunked(short) as unknown as BodyInit, short.length],
    ["long, chunked", chunked(long) as unknown as BodyInit, long.length],
  ] as const) {
    const response = await send("POST", "/api/sample/dataset", body);
    expect(response.status, name).toBe(400);
    const error = await errorOf(response);
    expect(error.code, name).toBe("sample.import_wrong_size");
    expect(error.data["size"], name).toBe(zipBytes.length);
    // A body counted while it is read stops at the first byte too many.
    if (name !== "long, chunked") expect(error.data["found"], name).toBe(found);
    expect(existsSync(zipPath()), name).toBe(false);
    expect(leftovers(), name).toEqual([]);
  }
  expect((await send("POST", "/api/sample/dataset")).status).toBe(400);
});

test("a refused import leaves the zip that is kept as it was", async () => {
  expect((await send("POST", "/api/sample/dataset", zipBytes as Uint8Array<ArrayBuffer>)).status).toBe(200);
  const wrong = new Uint8Array(zipBytes).fill(7);
  expect((await send("POST", "/api/sample/dataset", wrong as Uint8Array<ArrayBuffer>)).status).toBe(400);
  expect(new Uint8Array(readFileSync(zipPath()))).toEqual(zipBytes);
  expect(leftovers()).toEqual([]);
});

test("deleting removes the kept zip, and asking again is not an error", async () => {
  mkdirSync(downloads(), { recursive: true });
  writeFileSync(zipPath(), zipBytes);
  const deleted = await send("DELETE", "/api/sample/dataset");
  expect(deleted.status).toBe(200);
  expect((await deleted.json()) as SampleDatasetFileView).toEqual({ present: false, size: null, fileName: "test-dataset.zip" });
  expect(existsSync(zipPath())).toBe(false);
  expect((await send("DELETE", "/api/sample/dataset")).status).toBe(200);
});

test("while a run downloads the zip, it can neither be deleted nor replaced", async () => {
  files.stallNextResponseAfter(5);
  const engine = await addEngine();
  const started = await send("POST", "/api/sample/start", JSON.stringify({ engineId: engine.id }));
  const run = (await started.json()) as RunView;
  await eventually(async () => files.requests.length > 0);

  const deleted = await send("DELETE", "/api/sample/dataset");
  expect(deleted.status).toBe(409);
  expect(await errorOf(deleted)).toEqual({ code: "sample.dataset_in_use", data: {} });
  const imported = await send("POST", "/api/sample/dataset", zipBytes as Uint8Array<ArrayBuffer>);
  expect(imported.status).toBe(409);
  expect((await errorOf(imported)).code).toBe("sample.dataset_in_use");

  expect((await send("POST", `/api/runs/${run.id}/cancel`)).status).toBe(200);
  expect((await send("DELETE", "/api/sample/dataset")).status).toBe(200);
});
