import { assertCatalogueDrift } from "../../test-support/catalogue-drift.ts";
import type { ReconciledOption } from "../../shared/engine-options.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { folderSnapshot } from "../../test-support/import-folder.ts";
import { TaskClient } from "../task-api/task-client.ts";
import type { ProjectView, RunView } from "../../shared/api-types.ts";
import type { RunReviewView } from "../../shared/run-review.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { generateSigner, sampleManifest, signedRelease, type TestSigner } from "../../test-support/signed-manifest.ts";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { ACCEPTED_KEYS } from "../manifest/keys.ts";
import { SAMPLE_DATASET } from "../sample/sample-dataset.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

// This test drives the real task API in test mode (`--test`: it processes
// nothing), through the native package. It runs only where
// AIDM_REAL_TASK_API_VERSION names a release of AIDroneMap/aidm-api that
// has a Linux x64 archive, such as "2.6.1". It skips everywhere else.
//
// The archive's SHA-256 comes from the release's own SHA256SUMS over HTTPS.
// That proves only that the download is whole, not that the release is the
// right one. The real check comes from the signed manifest, once aidm-api
// publishes one (AIDroneMap/aidm-api#25).
const version = process.env.AIDM_REAL_TASK_API_VERSION;
const SLOW = 300_000;

const archiveName = `aidm-api-${version}-linux-x64.tar.gz`;
const releaseUrl = `https://github.com/AIDroneMap/aidm-api/releases/download/v${version}`;

/** The checksum the release publishes for the archive, over HTTPS. */
async function publishedChecksum(): Promise<string> {
  const response = await fetch(`${releaseUrl}/SHA256SUMS`, { redirect: "follow" });
  if (!response.ok) throw new Error(`SHA256SUMS answered ${response.status}.`);
  for (const line of (await response.text()).split("\n")) {
    const [sum, name] = line.trim().split(/\s+\*?/);
    if (name === archiveName && sum !== undefined && /^[0-9a-f]{64}$/.test(sum)) return sum;
  }
  throw new Error(`SHA256SUMS has no line for ${archiveName}.`);
}

/** The archive's size in bytes, from a one-byte ranged request, since the manifest has to say it. */
async function archiveSize(): Promise<number> {
  const response = await fetch(`${releaseUrl}/${archiveName}`, { headers: { range: "bytes=0-0" }, redirect: "follow" });
  await response.body?.cancel();
  const total = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1] ?? response.headers.get("content-length");
  const size = Number(total);
  if (!Number.isSafeInteger(size) || size <= 1) throw new Error("The archive's size could not be read.");
  return size;
}

function archiveEntry(archive: Buffer, name: string): Buffer {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("ZIP directory not found");
  let offset = archive.readUInt32LE(end + 16);
  const count = archive.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP directory");
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const entryName = archive.subarray(offset + 46, offset + 46 + nameLength).toString();
    if (entryName === name) {
      if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid ZIP entry");
      const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
      const compressed = archive.subarray(start, start + compressedSize);
      const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (data === null || data.length !== size || Bun.hash.crc32(data) !== crc) throw new Error(`Invalid ZIP entry: ${name}`);
      return data;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found: ${name}`);
}

const real = test.skipIf(version === undefined || process.platform !== "linux" || process.arch !== "x64");

let scratch: string;
let files: FakeFileServer;
let signer: TestSigner;
let harness: Harness | undefined;

beforeAll(async () => {
  scratch = mkdtempSync(join(os.tmpdir(), "aidm-ui-real-"));
  files = new FakeFileServer();
  await files.start();
  signer = await generateSigner();
});

afterAll(async () => {
  await harness?.stop();
  await files.stop();
  rmSync(scratch, { recursive: true, force: true });
});

real(
  "the real task API in test mode is installed as a native package and runs the sample job",
  async () => {
    // A test mode engine processes nothing, so the dataset is a few small files with the names of images, never photos.
    const zip = join(scratch, "dataset.zip");
    writeStoredZip(
      zip,
      ["DJI_0001.JPG", "DJI_0002.JPG", "DJI_0003.JPG"].map((name, index) => ({
        name,
        data: new TextEncoder().encode(`test image ${index}\n`.repeat(50)),
      })),
    );
    const bytes = new Uint8Array(await Bun.file(zip).arrayBuffer());
    files.files.set("/dataset.zip", bytes);

    const manifest = sampleManifest({
      sequence: 2,
      packageVersion: version as string,
      variants: {
        "linux-amd64-cpu": {
          kind: "native",
          url: `${releaseUrl}/${archiveName}`,
          size: await archiveSize(),
          sha256: await publishedChecksum(),
          gpu: false,
        },
      },
    });
    const { bytes: manifestBytes, signature } = await signedRelease(signer, manifest);
    files.files.set(`/releases/download/v${version}/manifest.json`, manifestBytes);
    files.files.set(`/releases/download/v${version}/manifest.json.sig`, signature);
    files.redirects.set("/releases/latest/download/manifest.json", `/releases/download/v${version}/manifest.json`);

    const h = openHarness({
      enginePollMs: 250,
      runPollMs: 250,
      runtimes: {},
      updateReadyTimeoutMs: 120_000,
      sampleDataset: {
        ...SAMPLE_DATASET,
        name: "test-dataset",
        url: files.url("/dataset.zip"),
        size: bytes.length,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        imageCount: 3,
        fileName: "test-dataset.zip",
      },
      manifest: { releasesUrl: files.url("/releases"), keys: [signer.key, ...ACCEPTED_KEYS], fetch: (url, init) => fetch(url, init) },
      // The archive comes from GitHub with the real fetch; the program runs in test mode.
      native: { extraArgs: ["--test"] },
    });
    harness = h;

    const refreshed = (await (await fetch(`${h.base}/api/packages/refresh`, { method: "POST" })).json()) as { result: { ok: boolean } };
    expect(refreshed.result.ok).toBe(true);
    expect((await fetch(`${h.base}/api/local-engine/install`, { method: "POST" })).status).toBe(202);
    await eventually(async () => h.localEngine.view().state === "ready", 180_000);
    expect(h.localEngine.view().installed).toMatchObject({ packageVersion: version, kind: "native", runtime: null });

    const engineId = h.engineStore.local()?.id as number;
    const reconciled = await fetch(`${h.base}/api/engines/${engineId}/options`);
    expect(reconciled.status).toBe(200);
    const catalogue = (await reconciled.json()) as { options: ReconciledOption[] };
    assertCatalogueDrift(catalogue.options, version as string);

    const events: RunView[] = [];
    const unsubscribe = h.tracker.subscribe(1, (event) => { if (event.type === "run") events.push(event.run); });
    const started = await fetch(`${h.base}/api/sample/start`, { method: "POST", body: JSON.stringify({ engineId }) });
    expect(started.status).toBe(202);
    const run = (await started.json()) as RunView;
    expect(run.id).toBe(1);
    let last: RunView | undefined;
    await eventually(async () => {
      last = (await (await fetch(`${h.base}/api/runs/${run.id}`)).json()) as RunView;
      return last.resultsAvailable || last.state === "failed" || last.results?.state === "failed";
    }, 240_000);
    unsubscribe();
    expect(last?.state).toBe("completed");
    expect(last?.resultsAvailable).toBe(true);
    expect(events.some((event) => event.step === "results" && !event.resultsAvailable)).toBe(true);
    const stored = join(h.dataFolder, "projects", String(run.projectId), "runs", String(run.id), "results.zip");
    const archive = Buffer.from(await Bun.file(stored).arrayBuffer());
    expect(archive.length).toBeGreaterThan(0);
    expect(last?.results).toMatchObject({ state: "ready", archiveSize: archive.length });
    const outputs = [
      { name: "orthophoto", path: "odm_orthophoto/odm_orthophoto.tif", route: "outputs/orthophoto" },
      { name: "glb", path: "odm_texturing/odm_textured_model_geo.glb", route: "outputs/glb" },
      { name: null, path: "orthophoto_tiles/16/16020/42443.png", route: "tiles/orthophoto/16/16020/42443.png" },
    ];
    for (const output of outputs) {
      const expected = archiveEntry(archive, output.path);
      expect(expected.length).toBeGreaterThan(0);
      if (output.name !== null) expect(last?.results?.outputs).toContainEqual({ name: output.name, size: expected.length });
      const response = await fetch(`${h.base}/api/runs/${run.id}/${output.route}`);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(expected));
    }
    const download = await fetch(`${h.base}/api/runs/${run.id}/results`);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(archive);
    const projectBefore = await (await fetch(`${h.base}/api/projects/${run.projectId}`)).json() as ProjectView;
    expect(projectBefore.resultsBytes).toBe(archive.length);
    expect(projectBefore.resultArchives).toEqual([{ runId: run.id, size: archive.length }]);
    const savedRun = h.runs.get(run.id)!;
    const log = await (await fetch(`${h.base}/api/runs/${run.id}/log`)).json();
    expect(savedRun.taskUuid).not.toBeNull();
    const engine = h.engineStore.get(engineId)!;
    const client = new TaskClient({ address: engine.address, token: engine.token });
    expect((await client.taskInfo(savedRun.taskUuid!)).ok).toBe(true);
    expect((await fetch(`${h.base}/api/runs/${run.id}/results`, { method: "DELETE" })).status).toBe(200);
    expect(await Bun.file(stored).exists()).toBe(false);
    const after = await (await fetch(`${h.base}/api/runs/${run.id}`)).json() as RunView;
    expect(after).toMatchObject({ state: "completed", resultsAvailable: false, results: { state: "deleted" } });
    expect(h.runs.get(run.id)?.options).toEqual(savedRun.options);
    expect(h.runs.get(run.id)?.taskUuid).toBe(savedRun.taskUuid);
    expect(await (await fetch(`${h.base}/api/runs/${run.id}/log`)).json()).toEqual(log);
    expect((await client.taskInfo(savedRun.taskUuid!)).ok).toBe(true);
    const projectAfter = await (await fetch(`${h.base}/api/projects/${run.projectId}`)).json() as ProjectView;
    expect(projectAfter.resultsBytes).toBe(0);
    expect(projectAfter.resultArchives).toEqual([]);

    const linkedProjectResponse = await fetch(`${h.base}/api/projects`, { method: "POST", body: JSON.stringify({ name: "Linked field", notes: "" }) });
    expect(linkedProjectResponse.status).toBe(201);
    const linkedProject = await linkedProjectResponse.json() as ProjectView;
    const linkPath = `${h.base}/api/projects/${linkedProject.id}/link`;
    const linkUrl = files.url("/linked-dataset.zip");
    files.files.set("/linked-dataset.zip", bytes);
    const selected = await fetch(linkPath, { method: "PUT", body: JSON.stringify({ url: linkUrl }) });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({ url: linkUrl, size: bytes.length, facts: null, factsRunId: null });
    expect(files.requests.filter(request => request.path === "/linked-dataset.zip").map(request => request.method)).toEqual(["HEAD"]);
    expect(await (await fetch(linkPath)).json()).toEqual({ url: linkUrl, size: null, facts: null, factsRunId: null });

    const linkedReviewResponse = await fetch(`${h.base}/api/projects/${linkedProject.id}/run-review?engineId=${engineId}&preset=quick-map&offset=0`);
    expect(linkedReviewResponse.status).toBe(200);
    const linkedReview = await linkedReviewResponse.json() as RunReviewView;
    expect(linkedReview).toMatchObject({ wayIn: "link", photos: { included: null, excluded: null, total: null, bytes: null }, blocked: null });
    const linkedStart = await fetch(`${h.base}/api/projects/${linkedProject.id}/runs`, {
      method: "POST", body: JSON.stringify({ engineId, preset: "quick-map", name: "Linked field", revision: linkedReview.revision }),
    });
    expect(linkedStart.status).toBe(202);
    const linkedRun = await linkedStart.json() as RunView;
    expect(linkedRun).toMatchObject({ projectId: linkedProject.id, wayIn: "link", upload: null });
    let linkedCompleted: RunView | undefined;
    await eventually(async () => {
      linkedCompleted = await (await fetch(`${h.base}/api/runs/${linkedRun.id}`)).json() as RunView;
      return linkedCompleted.resultsAvailable || linkedCompleted.state === "failed" || linkedCompleted.results?.state === "failed";
    }, 240_000);
    expect(linkedCompleted).toMatchObject({ state: "completed", resultsAvailable: true, results: { state: "ready" } });
    expect(files.requests.filter(request => request.path === "/linked-dataset.zip").map(request => request.method)).toEqual(["HEAD", "HEAD", "GET"]);
    const linkedArchiveResponse = await fetch(`${h.base}/api/runs/${linkedRun.id}/results`);
    expect(linkedArchiveResponse.status).toBe(200);
    const linkedArchive = Buffer.from(await linkedArchiveResponse.arrayBuffer());
    const images = JSON.parse(archiveEntry(linkedArchive, "images.json").toString()) as unknown;
    expect(images).toMatchObject([{ filename: "DJI_0028.JPG", camera_make: "DJI", camera_model: "FC300S", width: 4000, height: 2250 }]);
    expect(await (await fetch(linkPath)).json()).toEqual({
      url: linkUrl, size: null, factsRunId: linkedRun.id,
      facts: { photoCount: 1, withoutGps: 0, cameras: [{ make: "DJI", model: "FC300S", photoCount: 1 }], dimensions: [{ width: 4000, height: 2250, photoCount: 1 }] },
    });

    const projectResponse = await fetch(`${h.base}/api/projects`, { method: "POST", body: JSON.stringify({ name: "Uploaded field", notes: "" }) });
    expect(projectResponse.status).toBe(201);
    const uploadedProject = await projectResponse.json() as ProjectView;
    for (let index = 0; index < 3; index++) {
      const photo = `test image ${index}\n`.repeat(50);
      const sha256 = new Bun.CryptoHasher("sha256").update(photo).digest("hex");
      const upload = await fetch(`${h.base}/api/projects/${uploadedProject.id}/uploads`, {
        method: "POST", body: JSON.stringify({ name: `photo-${index}.jpg`, size: Buffer.byteLength(photo), sha256 }),
      });
      expect(upload.status).toBe(201);
      const session = await upload.json() as { id: string };
      const path = `${h.base}/api/projects/${uploadedProject.id}/uploads/${session.id}`;
      expect((await fetch(`${path}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": sha256 }, body: photo })).status).toBe(204);
      expect((await fetch(`${path}/complete`, { method: "POST" })).status).toBe(200);
    }
    await eventually(async () => {
      const facts = await (await fetch(`${h.base}/api/projects/${uploadedProject.id}/photo-facts`)).json() as { photoCount: number; pendingMetadata: number };
      return facts.photoCount === 3 && facts.pendingMetadata === 0;
    });
    const reviewResponse = await fetch(`${h.base}/api/projects/${uploadedProject.id}/run-review?engineId=${engineId}&preset=quick-map&offset=0`);
    expect(reviewResponse.status).toBe(200);
    const review = await reviewResponse.json() as RunReviewView;
    expect(review).toMatchObject({ project: { id: uploadedProject.id }, engine: { id: engineId }, preset: "quick-map", wayIn: "upload", photos: { included: 3, excluded: 0, total: 3 }, blocked: null });
    expect(review.revision).toBeTruthy();
    const startResponse = await fetch(`${h.base}/api/projects/${uploadedProject.id}/runs`, {
      method: "POST", body: JSON.stringify({ engineId, preset: "quick-map", name: "Quick map field", revision: review.revision }),
    });
    expect(startResponse.status).toBe(202);
    const projectRun = await startResponse.json() as RunView;
    expect(projectRun).toMatchObject({ projectId: uploadedProject.id, engineId, preset: "quick-map", name: "Quick map field", wayIn: "upload", sample: false });
    let completed: RunView | undefined;
    await eventually(async () => {
      completed = await (await fetch(`${h.base}/api/runs/${projectRun.id}`)).json() as RunView;
      return completed.resultsAvailable || completed.state === "failed" || completed.results?.state === "failed";
    }, 240_000);
    expect(completed).toMatchObject({ state: "completed", resultsAvailable: true, results: { state: "ready" } });
    const projectArchiveResponse = await fetch(`${h.base}/api/runs/${projectRun.id}/results`);
    expect(projectArchiveResponse.status).toBe(200);
    const projectArchive = Buffer.from(await projectArchiveResponse.arrayBuffer());
    expect(completed?.results?.archiveSize).toBe(projectArchive.length);
    const orthophoto = archiveEntry(projectArchive, "odm_orthophoto/odm_orthophoto.tif");
    expect(orthophoto.length).toBeGreaterThan(0);
    expect(completed?.results?.outputs).toContainEqual({ name: "orthophoto", size: orthophoto.length });
    const orthophotoResponse = await fetch(`${h.base}/api/runs/${projectRun.id}/outputs/orthophoto`);
    expect(orthophotoResponse.status).toBe(200);
    expect(new Uint8Array(await orthophotoResponse.arrayBuffer())).toEqual(new Uint8Array(orthophoto));

    const source = join(scratch, "imported-photos");
    await mkdir(source);
    for (let index = 0; index < 3; index++) await writeFile(join(source, `photo-${index}.jpg`), `synthetic imported image ${index}\n`, { mode: 0o444 });
    await chmod(source, 0o555);
    try {
      const before = await folderSnapshot(source);
      const project = await (await fetch(`${h.base}/api/projects`, { method: "POST", body: JSON.stringify({ name: "Imported field", notes: "" }) })).json() as { id: number };
      expect((await fetch(`${h.base}/api/projects/${project.id}/import`, { method: "PUT", body: JSON.stringify({ path: source }) })).status).toBe(200);
      expect(await (await fetch(`${h.base}/api/projects/${project.id}/photo-facts`)).json()).toMatchObject({ photoCount: 3, pendingMetadata: 0 });
      const engine = h.engineStore.get(engineId)!;
      const client = new TaskClient({ address: engine.address, token: engine.token });
      const created = await client.createTask("Imported field", []);
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("Could not create imported task");
      try {
        expect((await h.ctx.imports.copyToTask(project.id, client, created.value.uuid)).ok).toBe(true);
        expect((await client.commitTask(created.value.uuid)).ok).toBe(true);
        let status: unknown;
        await eventually(async () => {
          const info = await client.taskInfo(created.value.uuid);
          if (!info.ok) return false;
          status = info.value.statusCode;
          return status === 40 || status === 30;
        }, 240_000);
        expect(status).toBe(40);
        expect(await folderSnapshot(source)).toEqual(before);
      } finally { await client.removeTask(created.value.uuid); }
    } finally { await chmod(source, 0o700); }
  },
  SLOW,
);
