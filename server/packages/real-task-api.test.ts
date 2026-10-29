import { assertCatalogueDrift } from "../../test-support/catalogue-drift.ts";
import type { ReconciledOption } from "../../shared/engine-options.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { folderSnapshot } from "../../test-support/import-folder.ts";
import { TaskClient } from "../task-api/task-client.ts";
import type { RunView } from "../../shared/api-types.ts";
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

    const started = await fetch(`${h.base}/api/sample/start`, { method: "POST", body: JSON.stringify({ engineId }) });
    expect(started.status).toBe(202);
    const run = (await started.json()) as RunView;
    let last: RunView | undefined;
    await eventually(async () => {
      last = (await (await fetch(`${h.base}/api/runs/${run.id}`)).json()) as RunView;
      return last.state === "completed" || last.state === "failed";
    }, 240_000);
    expect(last?.state).toBe("completed");

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
