// The rule: the sample photos are kept at <data>/downloads/<fileName> and reused
// while their SHA-256 is the pinned one. Each test downloads them once through a
// first run, does something that could lose them, and checks that the zip is
// still there, byte for byte, and that the file host saw one request in all.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { EngineView, LocalEngineView, RunView, SampleView } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { generateSigner, sampleManifest, signedRelease, type TestSigner } from "../../test-support/signed-manifest.ts";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { ACCEPTED_KEYS } from "../manifest/keys.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";
import { SAMPLE_DATASET, type SampleDatasetEntry } from "./sample-dataset.ts";

const IMAGES = ["DJI_0001.JPG", "DJI_0002.JPG", "dji_0003.jpeg"];
const REPOSITORY = "ghcr.io/aidronemap/aidm-api";
const IMAGE_2_6_0 = `${REPOSITORY}@sha256:${"6".repeat(64)}`;

let scratch: string;
let dataFolder: string;
let zipBytes: Uint8Array<ArrayBuffer>;
let dataset: SampleDatasetEntry;
let files: FakeFileServer;
let releases: FakeFileServer;
let engineA: FakeTaskApi;
let engineB: FakeTaskApi;
let harness: Harness;

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

beforeEach(async () => {
  scratch = mkdtempSync(join(os.tmpdir(), "aidm-ui-kept-test-"));
  dataFolder = join(scratch, "data");
  mkdirSync(dataFolder);
  const path = join(scratch, "good.zip");
  writeStoredZip(path, IMAGES.map((name, index) => ({ name, data: new TextEncoder().encode(`image-${index}-`.repeat(20 + index)) })));
  zipBytes = new Uint8Array(readFileSync(path));
  files = new FakeFileServer({ "/dataset.zip": zipBytes });
  await files.start();
  releases = new FakeFileServer();
  await releases.start();
  dataset = {
    ...SAMPLE_DATASET,
    name: "test-dataset",
    url: files.url("/dataset.zip"),
    size: zipBytes.length,
    sha256: sha256(zipBytes),
    imageCount: IMAGES.length,
    fileName: "test-dataset.zip",
  };
  engineA = new FakeTaskApi();
  engineB = new FakeTaskApi({ token: "other-token" });
  await engineA.start();
  await engineB.start();
  harness = open();
});

afterEach(async () => {
  await harness.stop();
  await engineA.stop();
  await engineB.stop();
  await files.stop();
  await releases.stop();
  rmSync(scratch, { recursive: true, force: true });
});

function open(options: Parameters<typeof openHarness>[0] = {}): Harness {
  return openHarness({ enginePollMs: 50, runPollMs: 30, sampleDataset: dataset, architecture: "x64", dataFolder, ...options });
}

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harness.base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function getJson<T>(path: string): Promise<T> {
  return (await (await send("GET", path)).json()) as T;
}

async function addEngine(fake: FakeTaskApi, name: string): Promise<EngineView> {
  const response = await send("POST", "/api/engines", { name, address: fake.address, token: fake.token });
  expect(response.status).toBe(201);
  return (await response.json()) as EngineView;
}

async function startRun(engineId: number): Promise<RunView> {
  const response = await send("POST", "/api/sample/start", { engineId });
  expect(response.status).toBe(202);
  return (await response.json()) as RunView;
}

async function waitRun(id: number, state: RunView["state"]): Promise<RunView> {
  let last: RunView | undefined;
  await eventually(async () => {
    last = await getJson<RunView>(`/api/runs/${id}`);
    return last.state === state;
  });
  return last as RunView;
}

/** Starts a run on the engine and waits until the engine has the task. */
async function runQueued(fake: FakeTaskApi, engineId: number): Promise<{ run: RunView; uuid: string }> {
  const before = new Set(fake.tasks.keys());
  const run = await startRun(engineId);
  const queued = await waitRun(run.id, "queued");
  const uuid = [...fake.tasks.keys()].find((candidate) => !before.has(candidate));
  if (uuid === undefined) throw new Error("The engine has no new task.");
  return { run: queued, uuid };
}

async function finish(fake: FakeTaskApi, run: RunView, uuid: string): Promise<void> {
  fake.setTask(uuid, { statusCode: 40, processingTime: 9000, progress: 100, results: new Uint8Array([80, 75, 3, 4]) });
  await waitRun(run.id, "completed");
}

const zipPath = () => join(dataFolder, "downloads", dataset.fileName);

/** The zip is there with the same bytes, and the file host was asked for it once. */
function expectKept(): void {
  expect(existsSync(zipPath())).toBe(true);
  expect(new Uint8Array(readFileSync(zipPath()))).toEqual(zipBytes);
  expect(files.requests.filter((request) => request.path === "/dataset.zip")).toHaveLength(1);
}

test("a finished run leaves the zip in place", async () => {
  const engine = await addEngine(engineA, "Office");
  const first = await runQueued(engineA, engine.id);
  expectKept();
  await finish(engineA, first.run, first.uuid);
  expectKept();
});

test("a cancelled run leaves the zip in place, and the next run does not download it again", async () => {
  const engine = await addEngine(engineA, "Office");
  const first = await runQueued(engineA, engine.id);
  expect((await send("POST", `/api/runs/${first.run.id}/cancel`)).status).toBe(200);
  await waitRun(first.run.id, "cancelled");
  expectKept();

  await runQueued(engineA, engine.id);
  expectKept();
});

test("a failed run leaves the zip in place", async () => {
  const engine = await addEngine(engineA, "Office");
  const first = await runQueued(engineA, engine.id);
  engineA.setTask(first.uuid, { statusCode: 30, errorMessage: "Not enough memory" });
  await waitRun(first.run.id, "failed");
  expectKept();
});

test("a new run on another engine uses the kept zip", async () => {
  const office = await addEngine(engineA, "Office");
  const barn = await addEngine(engineB, "Barn");
  const first = await runQueued(engineA, office.id);
  await finish(engineA, first.run, first.uuid);

  const second = await runQueued(engineB, barn.id);
  expect(second.run.engineId).toBe(barn.id);
  expect(engineB.uploads).toHaveLength(IMAGES.length);
  expectKept();
});

test("Start again, which asks for the sample and starts a run, uses the kept zip", async () => {
  const engine = await addEngine(engineA, "Office");
  const first = await runQueued(engineA, engine.id);
  await finish(engineA, first.run, first.uuid);

  expect((await getJson<{ run: RunView | null }>("/api/sample")).run?.state).toBe("completed");
  await runQueued(engineA, engine.id);
  expectKept();
});

test("aidm-ui started again, as after an update of aidm-ui, uses the kept zip", async () => {
  const engine = await addEngine(engineA, "Office");
  const first = await runQueued(engineA, engine.id);
  await finish(engineA, first.run, first.uuid);
  await harness.stop();

  harness = open();
  // The monitor has to see the engine again before it is offered.
  await eventually(async () => (await getJson<SampleView>("/api/sample")).engines.some((offer) => offer.offered));
  await runQueued(engineA, engine.id);
  expectKept();
});

test("installing the local engine and updating it leave the zip in place", async () => {
  const signer: TestSigner = await generateSigner();
  const versionOf = (image: string) => (image === IMAGE_2_6_0 ? "2.6.0" : "2.5.0");
  await harness.stop();
  harness = open({
    runtimes: { podman: new FakeRuntime({ versionOf }) },
    updateReadyTimeoutMs: 3000,
    // The test key and the real list, because the built-in entry is signed by the real list's key.
    manifest: { releasesUrl: releases.url("/releases"), keys: [signer.key, ...ACCEPTED_KEYS], fetch: (url, init) => fetch(url, init) },
  });

  const engine = await addEngine(engineA, "Office");
  const first = await runQueued(engineA, engine.id);
  await finish(engineA, first.run, first.uuid);
  expectKept();

  const localView = async () => (await (await send("GET", "/api/local-engine")).json()) as LocalEngineView;
  expect((await send("POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView()).state === "ready");
  expectKept();

  const manifest = sampleManifest({
    sequence: 2,
    packageVersion: "2.6.0",
    variants: {
      "linux-amd64-cpu": { kind: "container", image: REPOSITORY, digest: IMAGE_2_6_0.slice(IMAGE_2_6_0.indexOf("@") + 1), size: 6_000, gpu: false },
    },
  });
  const { bytes, signature } = await signedRelease(signer, manifest);
  releases.files.set("/releases/download/v2.6.0/manifest.json", bytes);
  releases.files.set("/releases/download/v2.6.0/manifest.json.sig", signature);
  releases.redirects.set("/releases/latest/download/manifest.json", "/releases/download/v2.6.0/manifest.json");
  expect((await send("POST", "/api/packages/refresh")).status).toBe(200);

  expect((await send("POST", "/api/local-engine/update")).status).toBe(202);
  await eventually(async () => {
    const view = await localView();
    return view.installed?.packageVersion === "2.6.0" && view.update.applying === null;
  });
  expectKept();

  // And a run after all that still does not download the photos again.
  const barn = await addEngine(engineB, "Barn");
  await runQueued(engineB, barn.id);
  expectKept();
});

test("only the operator's delete removes the zip, and then the next run downloads it again", async () => {
  const engine = await addEngine(engineA, "Office");
  const first = await runQueued(engineA, engine.id);
  await finish(engineA, first.run, first.uuid);
  expectKept();

  expect((await send("DELETE", "/api/sample/dataset")).status).toBe(200);
  expect(existsSync(zipPath())).toBe(false);
  await runQueued(engineA, engine.id);
  expect(existsSync(zipPath())).toBe(true);
  expect(files.requests.filter((request) => request.path === "/dataset.zip")).toHaveLength(2);
});
