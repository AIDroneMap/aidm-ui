import { compareVersions } from "../engines/versions.ts";
import { modelAcceptanceAssets, assertArchivedModel } from "../../test-support/model-acceptance.ts";
import { assertCatalogueDrift, assertEditorRows } from "../../test-support/catalogue-drift.ts";
import { OPTION_CATALOGUE, OPTION_GROUPS } from "../../shared/option-catalogue.ts";
import type { ReconciledOption } from "../../shared/engine-options.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { folderSnapshot } from "../../test-support/import-folder.ts";
import { recordedMachine, windowsInputs } from "../../test-support/recorded-machine.ts";
import { TaskClient } from "../task-api/task-client.ts";
import type { ProjectView, RefreshView, RunView } from "../../shared/api-types.ts";
import type { RunReviewView } from "../../shared/run-review.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { generateSigner, sampleManifest, signedRelease, type TestSigner } from "../../test-support/signed-manifest.ts";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { ACCEPTED_KEYS } from "../manifest/keys.ts";
import { SAMPLE_DATASET } from "../sample/sample-dataset.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";
import { spawnEngine, type SpawnEngine } from "./native-package.ts";

// This test drives the real task API in test mode (`--test`: it processes
// nothing), through the native package. It runs only where
// AIDM_REAL_TASK_API_VERSION names a release of AIDroneMap/aidm-api that
// has an archive for this computer, such as "2.6.1", on Linux x64 or Windows
// x64. It skips everywhere else. On Windows the release has a zip, which the
// test unpacks and packs again as the tar.gz with one top folder that a
// native package is. At the end the engine manager starts again, finds the
// running program by its command line, and stops it with every process it
// started.
// Before release, ARCHIVE_PATH and ARCHIVE_SHA256 select a source-built native
// package on a disposable test machine. MODEL_ACCEPTANCE=1 also renders the
// archived model through the actual server route in Chromium.
//
// The archive's SHA-256 comes from the release's own SHA256SUMS over HTTPS.
// That proves only that the download is whole, not that the release is the
// right one. The real check comes from the signed manifest, once aidm-api
// publishes one (AIDroneMap/aidm-api#25).
const version = process.env.AIDM_REAL_TASK_API_VERSION;
const SLOW = 300_000;
// A locally built package can be exercised on a disposable test machine before release.
// Its digest is an explicit test input, not a publisher signature.
const packagePath = process.env.AIDM_REAL_TASK_API_ARCHIVE_PATH;
const packageSha256 = process.env.AIDM_REAL_TASK_API_ARCHIVE_SHA256;
const modelAcceptance = process.env.AIDM_REAL_TASK_API_MODEL_ACCEPTANCE === "1";

const windows = process.platform === "win32";
const archiveName = windows ? `aidm-api-${version}-windows-x64.zip` : `aidm-api-${version}-linux-x64.tar.gz`;
const releaseUrl = `https://github.com/AIDroneMap/aidm-api/releases/download/v${version}`;

function realTaskApiMachine(onWindows: boolean) {
  return {
    localMachine: { platform: onWindows ? "win32" : "linux", arch: "x64", totalMemory: 32 * 1024 ** 3, cpuCount: 8 },
    machine: onWindows ? recordedMachine(windowsInputs()) : undefined,
  };
}

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
  let found: Buffer | undefined;
  forEachZipEntry(archive, (entryName, read) => {
    if (entryName !== name) return true;
    found = read();
    return false;
  });
  if (found === undefined) throw new Error(`ZIP entry not found: ${name}`);
  return found;
}

/** Hands each entry of a ZIP file to `visit`, with a way to read it, until `visit` says no more. */
function forEachZipEntry(archive: Buffer, visit: (name: string, read: () => Buffer) => boolean): void {
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
    const read = () => {
      if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid ZIP entry");
      const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
      const compressed = archive.subarray(start, start + compressedSize);
      const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (data === null || data.length !== size || Bun.hash.crc32(data) !== crc) throw new Error(`Invalid ZIP entry: ${entryName}`);
      return data;
    };
    if (!visit(entryName, read)) return;
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

/**
 * The release's Windows zip, checked against its SHA256SUMS line, unpacked and
 * packed again as a tar.gz with one top folder, which is what a native
 * package is. Returns the new archive and its SHA-256.
 */
async function rewrappedWindowsZip(work: string): Promise<{ path: string; sha256: string }> {
  const response = await fetch(`${releaseUrl}/${archiveName}`, { redirect: "follow" });
  if (!response.ok) throw new Error(`${archiveName} answered ${response.status}.`);
  const zip = Buffer.from(await response.arrayBuffer());
  expect(new Bun.CryptoHasher("sha256").update(zip).digest("hex")).toBe(await publishedChecksum());
  const top = archiveName.replace(/\.zip$/, "");
  const unpacked = join(work, "unpacked");
  forEachZipEntry(zip, (name, read) => {
    if (name.split("/").includes("..") || name.startsWith("/")) throw new Error(`Unsafe ZIP entry: ${name}`);
    // The release zip holds one top folder; loose files would go into one.
    const path = join(unpacked, name.startsWith(`${top}/`) ? "" : top, name);
    if (name.endsWith("/")) mkdirSync(path, { recursive: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, read());
    }
    return true;
  });
  const archive = join(work, `${top}.tar.gz`);
  const packed = Bun.spawnSync(["tar", "-czf", archive, "-C", unpacked, top]);
  if (packed.exitCode !== 0) throw new Error(`tar failed: ${packed.stderr.toString()}`);
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(archive).stream()) hasher.update(chunk);
  return { path: archive, sha256: hasher.digest("hex") };
}

/** Every process of this computer with its parent. */
async function processes(): Promise<Array<{ pid: number; parent: number }>> {
  const argv = windows
    ? ["powershell", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance -ClassName Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"]
    : ["ps", "-e", "-o", "pid=,ppid="];
  const listed = Bun.spawnSync(argv);
  if (listed.exitCode !== 0) throw new Error(`Listing the processes failed: ${listed.stderr.toString()}`);
  return listed.stdout.toString().split(/\r?\n/).flatMap((line) => {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    return pid === undefined || parent === undefined || Number.isNaN(pid) || Number.isNaN(parent) ? [] : [{ pid, parent }];
  });
}

/** The process and every process below it. */
async function processTree(root: number): Promise<number[]> {
  const all = await processes();
  const tree = [root];
  for (let index = 0; index < tree.length; index++) {
    for (const child of all) if (child.parent === tree[index] && child.pid !== root && !tree.includes(child.pid)) tree.push(child.pid);
  }
  return tree;
}

const real = test.skipIf(version === undefined || !(process.platform === "linux" || windows) || process.arch !== "x64");

let scratch: string;
let files: FakeFileServer;
let signer: TestSigner;
let harness: Harness | undefined;
let packageServer: Bun.Server<undefined> | undefined;

beforeAll(async () => {
  scratch = mkdtempSync(join(os.tmpdir(), "aidm-ui-real-"));
  files = new FakeFileServer();
  await files.start();
  signer = await generateSigner();
});

afterAll(async () => {
  await harness?.stop();
  await files.stop();
  packageServer?.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

test("the real task API's Windows machine offers the Windows CPU package", async () => {
  const manifest = sampleManifest();
  manifest.variants = { "windows-x64": manifest.variants["windows-x64"]! };
  const { bytes, signature } = await signedRelease(signer, manifest);
  files.files.set("/machine/releases/download/v2.6.0/manifest.json", bytes);
  files.files.set("/machine/releases/download/v2.6.0/manifest.json.sig", signature);
  files.redirects.set("/machine/releases/latest/download/manifest.json", "/machine/releases/download/v2.6.0/manifest.json");
  const h = openHarness({
    ...realTaskApiMachine(true),
    runtimes: {},
    manifest: { releasesUrl: files.url("/machine/releases"), keys: [signer.key, ...ACCEPTED_KEYS], fetch: (url, init) => fetch(url, init) },
  });
  try {
    const response = await fetch(`${h.base}/api/packages/refresh`, { method: "POST" });
    expect(response.status).toBe(200);
    const refreshed = await response.json() as RefreshView;
    expect(refreshed.result.ok).toBe(true);
    expect(refreshed.view.reason).toBeNull();
    expect(refreshed.view.offer).toMatchObject({ variant: "windows-x64", kind: "native" });
  } finally {
    await h.stop();
  }
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

    let sourcePackageFetch: typeof fetch | undefined;
    let variant = { url: `${releaseUrl}/${archiveName}`, size: 0, sha256: "" };
    const rewrapped = packagePath === undefined && windows ? await rewrappedWindowsZip(scratch) : undefined;
    const localPackage = packagePath ?? rewrapped?.path;
    const localSha256 = packagePath === undefined ? rewrapped?.sha256 : packageSha256;
    if (localPackage !== undefined) {
      if (!localSha256 || !/^[0-9a-f]{64}$/.test(localSha256)) throw new Error("A source-built package requires its expected SHA-256.");
      const file = Bun.file(localPackage);
      if (!(await file.exists())) throw new Error("Source-built native package not found.");
      const hasher = new Bun.CryptoHasher("sha256");
      for await (const chunk of file.stream()) hasher.update(chunk);
      expect(hasher.digest("hex")).toBe(localSha256);
      packageServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
        if (new URL(request.url).pathname !== "/native.tar.gz") return new Response(null, { status: 404 });
        return new Response(file);
      } });
      variant = { url: "https://source-package.test/native.tar.gz", size: file.size, sha256: localSha256 };
      // Keep the manifest schema unchanged. Only this test's fetch maps the
      // declared HTTPS address to the local source-built archive server.
      sourcePackageFetch = ((input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== variant.url) throw new Error("Unexpected source-package request.");
        return fetch(`http://127.0.0.1:${packageServer!.port}/native.tar.gz`, init);
      }) as typeof fetch;
    } else {
      variant.size = await archiveSize();
      variant.sha256 = await publishedChecksum();
    }
    const assets = modelAcceptance ? await modelAcceptanceAssets(join(scratch, "viewer")) : undefined;
    const manifest = sampleManifest({
      packageVersion: version as string,
      variants: {
        [windows ? "windows-x64" : "linux-amd64-cpu"]: {
          kind: "native",
          ...variant,
          gpu: false,
        },
      },
    });
    const { bytes: manifestBytes, signature } = await signedRelease(signer, manifest);
    files.files.set(`/releases/download/v${version}/manifest.json`, manifestBytes);
    files.files.set(`/releases/download/v${version}/manifest.json.sig`, signature);
    files.redirects.set("/releases/latest/download/manifest.json", `/releases/download/v${version}/manifest.json`);

    const taskCalls: string[] = [];
    // The engine's starts, so that the restart at the end can show that none was added.
    const starts: number[] = [];
    const spawn: SpawnEngine = (argv, options) => {
      const child = spawnEngine(argv, options);
      starts.push(child.pid);
      return child;
    };
    // On disk, so that the engine manager can start again on it, with a space in its path, as in a Windows user name with a space.
    const dataFolder = join(scratch, "aidm ui data");
    mkdirSync(dataFolder);
    const harnessOptions: Parameters<typeof openHarness>[0] = {
      dataFolder,
      ...realTaskApiMachine(windows),
      assets,
      enginePollMs: 250,
      runPollMs: 250,
      runClientFor: endpoint => new TaskClient(endpoint, { fetch: (async (input, init) => {
        taskCalls.push(new URL(String(input)).pathname);
        return fetch(input, init);
      }) as typeof fetch }),
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
      // The archive uses real HTTP and installation; the program runs in test mode.
      native: { extraArgs: ["--test"], fetch: sourcePackageFetch, spawn },
    };
    const h = openHarness(harnessOptions);
    harness = h;

    /**
     * The engine manager starts again, as when the operator opens aidm-ui again, and finds the program it left running by its
     * command line. Switched off, the engine goes with every process it started.
     */
    const restartAndSwitchOff = async () => {
      const running = h.settings.get("local.native");
      expect(running).not.toBeNull();
      const pid = running!.pid;
      const startsBefore = starts.length;
      await h.stop({ leaveEngines: true });
      harness = undefined;
      expect((await processes()).some((process) => process.pid === pid)).toBe(true);
      const again = openHarness(harnessOptions);
      harness = again;
      await eventually(async () => again.localEngine.view().state === "ready", 120_000);
      expect(starts).toHaveLength(startsBefore);
      expect(again.settings.get("local.native")?.pid).toBe(pid);
      console.log("The engine manager started again and found the running engine", JSON.stringify({ pid, starts: starts.length }));

      // Switched off, the engine goes with every process it started.
      const tree = await processTree(pid);
      const off = await fetch(`${again.base}/api/local-engine/enabled`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
      expect(off.status).toBe(200);
      expect(again.settings.get("local.native")).toBeNull();
      let left: number[] = tree;
      await eventually(async () => {
        const now = new Set((await processes()).map((process) => process.pid));
        left = tree.filter((member) => now.has(member));
        return left.length === 0;
      }, 30_000);
      expect(left).toEqual([]);
      console.log("The engine was switched off and no process of its tree is left", JSON.stringify({ tree }));
    };

    const refreshed = (await (await fetch(`${h.base}/api/packages/refresh`, { method: "POST" })).json()) as { result: { ok: boolean } };
    expect(refreshed.result.ok).toBe(true);
    const install = await fetch(`${h.base}/api/local-engine/install`, { method: "POST" });
    expect(install.status, await install.clone().text()).toBe(202);
    await eventually(async () => h.localEngine.view().state === "ready", 180_000);
    expect(h.localEngine.view().installed).toMatchObject({ packageVersion: version, kind: "native", runtime: null });

    const engineId = h.engineStore.local()?.id as number;
    const reconciled = await fetch(`${h.base}/api/engines/${engineId}/options`);
    expect(reconciled.status).toBe(200);
    const catalogue = (await reconciled.json()) as { options: ReconciledOption[] };
    // The package runs in test mode, so it serves the list bundled in its release, whatever version it is.
    assertCatalogueDrift(catalogue.options, version as string, "test-mode");

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
    if (modelAcceptance) {
      const rendered = await assertArchivedModel(h.base, run.id, { screenshotPath: process.env.AIDM_REAL_TASK_API_MODEL_SCREENSHOT });
      expect(rendered.outputRequests).toBeGreaterThan(0);
      expect(rendered.coloredPixels).toBeGreaterThan(0);
      expect(rendered.externalRequests).toEqual([]);
      console.info("Archived model rendered", JSON.stringify({ runId: run.id, ...rendered }));
    }
    const mapResponse = await fetch(`${h.base}/api/runs/${run.id}/map`);
    expect(mapResponse.status).toBe(200);
    const map = await mapResponse.json() as import("../../shared/map.ts").RunMapView;
    expect(map.state).toBe("ready");
    const mapOrthophoto = map.layers.find(layer => layer.name === "orthophoto");
    expect(mapOrthophoto).toMatchObject({ kind: "tiles", scheme: "tms", minZoom: 16, maxZoom: 18 });
    // Independent projection of the pinned fixture's EPSG:32615 raster corners.
    const expectedBounds = [-91.99451323800885, 46.842167553856164, -91.9931045333495, 46.843133788493624];
    expectedBounds.forEach((value, index) => expect(mapOrthophoto!.bounds[index]).toBeCloseTo(value, 7));
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
    // The sample job asks for map tiles, and the engine has them among the task's options.
    const sampleInfo = await (await fetch(`${engine.address}/task/${encodeURIComponent(savedRun.taskUuid!)}/info?token=${encodeURIComponent(engine.token)}`)).json() as { options: Array<{ name: string; value: unknown }> };
    expect(sampleInfo.options).toContainEqual({ name: "tiles", value: true });
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
    // On Windows the test proves the start path of a native package: the install, the sample job, the restart and the stop.
    // The other ways in, the presets and the imports are proven on Linux.
    if (windows) return restartAndSwitchOff();

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
    const editedSettings = [{ name: "orthophoto-resolution", value: 8 }];
    const reviewResponse = await fetch(`${h.base}/api/projects/${uploadedProject.id}/run-review`, {
      method: "POST", body: JSON.stringify({ engineId, preset: "quick-map", options: editedSettings }),
    });
    expect(reviewResponse.status).toBe(200);
    const review = await reviewResponse.json() as RunReviewView;
    expect(review).toMatchObject({ project: { id: uploadedProject.id }, engine: { id: engineId }, preset: "quick-map", wayIn: "upload", photos: { included: 3, excluded: 0, total: 3 }, blocked: null });
    expect(review.revision).toBeTruthy();
    expect(review.options).toContainEqual(expect.objectContaining({ name: "orthophoto-resolution", value: 8 }));
    // The editor has one row per option the live task API reports, with the exact exception of the list a test-mode package bundles.
    const reportedOptions = await client.options();
    if (!reportedOptions.ok) throw new Error("The task API did not list its options.");
    assertEditorRows(reportedOptions.value, review.settings!.options, version as string, "test-mode");
    const taskOptions = async (uuid: string) => (await (await fetch(`${engine.address}/task/${encodeURIComponent(uuid)}/info?token=${encodeURIComponent(engine.token)}`)).json() as { options: Array<{ name: string; value: unknown }> }).options;
    const presetResponse = await fetch(`${h.base}/api/presets`, { method: "POST", body: JSON.stringify({ options: editedSettings, preset: "Field settings", engineVersion: review.engine.info.engineVersion ?? null }) });
    expect(presetResponse.status).toBe(201);
    const savedPreset = await presetResponse.json() as import("../../shared/settings-file.ts").SavedPreset;
    expect(await (await fetch(`${h.base}/api/presets/${savedPreset.id}`)).json()).toEqual(savedPreset);
    const namedReviewResponse = await fetch(`${h.base}/api/projects/${uploadedProject.id}/run-review`, { method: "POST", body: JSON.stringify({ engineId, preset: "quick-map", presetName: savedPreset.preset, options: savedPreset.options }) });
    expect(namedReviewResponse.status).toBe(200);
    const namedReview = await namedReviewResponse.json() as RunReviewView;
    const startResponse = await fetch(`${h.base}/api/projects/${uploadedProject.id}/runs`, {
      method: "POST", body: JSON.stringify({ engineId, preset: "quick-map", presetName: savedPreset.preset, name: "Quick map field", revision: namedReview.revision, options: savedPreset.options }),
    });
    expect(startResponse.status).toBe(202);
    const projectRun = await startResponse.json() as RunView;
    expect(projectRun).toMatchObject({ projectId: uploadedProject.id, engineId, preset: "quick-map", presetName: "Field settings", name: "Quick map field", wayIn: "upload", sample: false });
    expect(h.runs.get(projectRun.id)?.options).toContainEqual({ name: "orthophoto-resolution", value: 8 });
    let completed: RunView | undefined;
    await eventually(async () => {
      completed = await (await fetch(`${h.base}/api/runs/${projectRun.id}`)).json() as RunView;
      return completed.resultsAvailable || completed.state === "failed" || completed.results?.state === "failed";
    }, 240_000);
    expect(completed).toMatchObject({ state: "completed", resultsAvailable: true, results: { state: "ready" } });
    // Left at their defaults, map tiles are on and this CPU package runs without a GPU, as the server sets them.
    const untouchedOptions = await taskOptions(h.runs.get(projectRun.id)!.taskUuid!);
    expect(untouchedOptions).toContainEqual({ name: "tiles", value: true });
    expect(untouchedOptions).toContainEqual({ name: "no-gpu", value: true });
    expect((await fetch(`${h.base}/api/presets/${savedPreset.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await (await fetch(`${h.base}/api/runs/${projectRun.id}`)).json()).presetName).toBe("Field settings");
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

    const originalTask = h.runs.get(projectRun.id)!.taskUuid!;
    const repeatBody = { engineId, preset: "custom", sourceRunId: projectRun.id, options: [{ name: "orthophoto-resolution", value: 9 }] };
    const repeatProject = async () => {
      const response = await fetch(`${h.base}/api/projects/${uploadedProject.id}/run-review`, { method: "POST", body: JSON.stringify(repeatBody) });
      expect(response.status).toBe(200);
      const review = await response.json() as RunReviewView;
      const start = await fetch(`${h.base}/api/projects/${uploadedProject.id}/runs`, { method: "POST", body: JSON.stringify({ ...repeatBody, name: "Repeated field", revision: review.revision }) });
      expect(start.status).toBe(202);
      const run = await start.json() as RunView;
      await eventually(async () => {
        const view = await (await fetch(`${h.base}/api/runs/${run.id}`)).json() as RunView;
        return view.resultsAvailable || view.state === "failed" || view.results?.state === "failed";
      }, 240_000);
      expect(h.tracker.view(run.id)).toMatchObject({ state: "completed", resultsAvailable: true });
      return h.runs.get(run.id)!;
    };
    const repeated = await repeatProject();
    expect(repeated.taskUuid).toBe(originalTask);
    expect(repeated.options).toContainEqual({ name: "orthophoto-resolution", value: 9 });
    expect(Buffer.from(await (await fetch(`${h.base}/api/runs/${projectRun.id}/results`)).arrayBuffer())).toEqual(projectArchive);
    expect((await client.removeTask(originalTask)).ok).toBe(true);
    const recreated = await repeatProject();
    expect(recreated.taskUuid).not.toBe(originalTask);
    const recreatedInfo = await client.taskInfo(recreated.taskUuid!);
    expect(recreatedInfo.ok && recreatedInfo.value.imagesCount).toBe(3);
    expect((await fetch(`${h.base}/api/runs/${recreated.id}`, { method: "DELETE" })).status).toBe(204);
    const removed = await client.taskInfo(recreated.taskUuid!);
    expect(removed.ok).toBe(false);

    // One edited option from each of the nine groups reaches the engine with exactly that value,
    // including the two the server would otherwise set (map tiles, the process count).
    const nineGroups = [
      { name: "gps-accuracy", value: 7 }, { name: "min-num-features", value: 12000 }, { name: "pc-filter", value: 3 },
      { name: "mesh-size", value: 150000 }, { name: "dsm", value: true }, { name: "crop", value: 2 },
      { name: "tiles", value: false }, { name: "max-concurrency", value: 2 }, { name: "merge", value: "orthophoto" },
    ];
    const groupOf = (name: string) => OPTION_CATALOGUE.find(option => option.name === name)?.group;
    expect(nineGroups.map(option => groupOf(option.name))).toEqual([...OPTION_GROUPS]);
    const groupsBody = { engineId, preset: "custom", options: nineGroups };
    const groupsReview = await (await fetch(`${h.base}/api/projects/${uploadedProject.id}/run-review`, { method: "POST", body: JSON.stringify(groupsBody) })).json() as RunReviewView;
    expect(groupsReview.blocked).toBeNull();
    expect(groupsReview.options.map(({ name, value }) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([...nineGroups].sort((a, b) => a.name.localeCompare(b.name)));
    const groupsStart = await fetch(`${h.base}/api/projects/${uploadedProject.id}/runs`, { method: "POST", body: JSON.stringify({ ...groupsBody, name: "Nine groups", revision: groupsReview.revision }) });
    expect(groupsStart.status).toBe(202);
    const groupsRun = await groupsStart.json() as RunView;
    await eventually(async () => {
      const view = await (await fetch(`${h.base}/api/runs/${groupsRun.id}`)).json() as RunView;
      return view.resultsAvailable || view.state === "failed" || view.results?.state === "failed";
    }, 240_000);
    expect(h.tracker.view(groupsRun.id)).toMatchObject({ state: "completed", resultsAvailable: true });
    const groupsOptions = await taskOptions(h.runs.get(groupsRun.id)!.taskUuid!);
    for (const option of nineGroups) expect(groupsOptions.filter(sent => sent.name === option.name)).toEqual([option]);
    console.log("Nine groups reached the engine", JSON.stringify(nineGroups));

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
      const info = await client.info();
      if (compareVersions(version as string, "2.7.0") >= 0) expect(info.ok && info.value.imagesPath).toBe(true);
      if (info.ok && info.value.imagesPath === true) {
        const review = await (await fetch(`${h.base}/api/projects/${project.id}/run-review?engineId=${engineId}&preset=quick-map`)).json() as RunReviewView;
        expect(review.importMode).toMatchObject({ available: true, selected: "in-place", restartRequired: false });
        const uploadCount = taskCalls.filter(path => path.includes("/task/new/upload/")).length;
        const response = await fetch(`${h.base}/api/projects/${project.id}/runs`, { method: "POST", body: JSON.stringify({ engineId, preset: "quick-map", name: "In-place field", revision: review.revision }) });
        expect(response.status).toBe(202);
        const run = await response.json() as RunView;
        await eventually(async () => (await (await fetch(`${h.base}/api/runs/${run.id}`)).json() as RunView).resultsAvailable, 240_000);
        expect(taskCalls.filter(path => path.includes("/task/new/upload/"))).toHaveLength(uploadCount);
        const completed = h.runs.get(run.id)!;
        const task = await client.taskInfo(completed.taskUuid!);
        expect(task.ok && task.value.imagesCount).toBe(3);
        const after = await folderSnapshot(source);
        expect(after.map(({ changed, ...entry }) => entry)).toEqual(before.map(({ changed, ...entry }) => entry));
        expect((await fetch(`${h.base}/api/runs/${run.id}`, { method: "DELETE" })).status).toBe(204);
        const removed = await folderSnapshot(source);
        expect(removed.map(({ changed, ...entry }) => entry)).toEqual(before.map(({ changed, ...entry }) => entry));
        console.log("In-place import acceptance passed", { photos: 3, uploads: 0, originalsPreserved: true });
      }
    } finally { await chmod(source, 0o700); }

    await restartAndSwitchOff();
  },
  SLOW,
);
