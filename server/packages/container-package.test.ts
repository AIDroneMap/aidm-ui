import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { InstallProgressView } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeImages } from "../../test-support/fake-images.ts";
import { FakeRegistry } from "../../test-support/fake-registry.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { WRONG_TOKEN_MESSAGE } from "../../test-support/fake-task-api.ts";
import { imageFolder, localName } from "../images/image-download.ts";
import { DOWNLOAD_FREE_DISK_MARGIN, IMAGE_UNPACKED_FACTOR } from "../machine/thresholds.ts";
import { fail, ok, type RuntimeResult } from "../runtimes/runtime.ts";
import { isNativePackage, type InstalledContainerPackage, type InstalledPackage } from "../settings/settings.ts";
import {
  CONTAINER_NAME,
  ContainerPackage,
  containerConfigFolder,
  ENGINE_CONFIG_FILE_NAME,
  type ContainerVariant,
} from "./container-package.ts";

const GiB = 1024 ** 3;
const VARIANT: ContainerVariant = {
  kind: "container",
  image: "ghcr.io/aidronemap/aidm-api",
  digest: `sha256:${"a".repeat(64)}`,
  size: 682_533_845,
  gpu: false,
};
const PINNED = { repository: VARIANT.image, digest: VARIANT.digest };
const IMAGE = `${VARIANT.image}@${VARIANT.digest}`;
/** The bytes a download of the fake image source reports. */
const FAKE_DOWNLOAD_SIZE = 3 * 1024 * 1024;
/** The one layer the fake image source says every image has. */
const FAKE_LAYERS = [{ digest: VARIANT.digest, size: FAKE_DOWNLOAD_SIZE - 2 }];
const STALLED: ApiError = { code: "download.stalled", data: { seconds: 300 } };

/** A runtime that names a loaded image by an ID of its own, as Podman and Docker do, or that cannot vouch for it. */
class VerifyingRuntime extends FakeRuntime {
  /** What verifyImage answers; null: what the fake runtime answers. */
  verification: RuntimeResult<string> | null = null;

  override async verifyImage(...args: Parameters<FakeRuntime["verifyImage"]>): ReturnType<FakeRuntime["verifyImage"]> {
    return this.verification ?? super.verifyImage(...args);
  }
}

/** A runtime whose first check of a loaded image fails. */
class UnverifiedOnce extends FakeRuntime {
  private failures = 1;

  override async verifyImage(...args: Parameters<FakeRuntime["verifyImage"]>): ReturnType<FakeRuntime["verifyImage"]> {
    if (this.failures-- > 0) return fail("runtime.image_not_verified", { name: args[0].name });
    return super.verifyImage(...args);
  }
}

const runtimes: FakeRuntime[] = [];
const folders: string[] = [];
const servers: FakeFileServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const runtime of runtimes.splice(0)) await runtime.remove(CONTAINER_NAME);
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function setup(options: { free?: number; runtime?: FakeRuntime; storagePath?: string | null; imageRef?: string } = {}) {
  const runtime = options.runtime ?? new FakeRuntime();
  runtimes.push(runtime);
  const dataFolder = mkdtempSync(join(tmpdir(), "aidm-container-package-"));
  folders.push(dataFolder);
  const images = new FakeImages();
  const asked: string[] = [];
  const pkg = new ContainerPackage({
    runtime,
    variant: VARIANT,
    variantId: "linux-amd64-cpu",
    freeBytes: (path) => {
      asked.push(path);
      return options.free ?? 100 * GiB;
    },
    storagePath: options.storagePath ?? null,
    dataFolder,
    images,
    ...(options.imageRef === undefined ? {} : { imageRef: options.imageRef }),
  });
  return { runtime, pkg, images, asked, dataFolder, folder: imageFolder(dataFolder, PINNED) };
}

const startOptions = {
  hostPort: 0,
  token: "t0ken",
  memoryBytes: 4 * GiB,
  cpus: 2,
  engineDataFolder: "/data/engine-data",
  gpu: false,
};

/** The room an install needs when the runtime's storage and the data folder are on one disk. */
function neededFor(runtime: FakeRuntime, bytesAlreadyOnDisk = 0): number {
  const forDownload = VARIANT.size - bytesAlreadyOnDisk + DOWNLOAD_FREE_DISK_MARGIN * VARIANT.size;
  const forRuntime = Math.ceil((runtime.loadCopies + IMAGE_UNPACKED_FACTOR) * VARIANT.size + DOWNLOAD_FREE_DISK_MARGIN * VARIANT.size);
  return Math.ceil(forDownload + forRuntime);
}

/** Leaves bytes of an unfinished download of the image, as a download that was cut short does. */
function leavePartOfDownload(folder: string, bytes: number): void {
  const blobs = join(folder, "blobs", "sha256");
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(blobs, `${"b".repeat(64)}.part`), new Uint8Array(bytes));
}

test("install downloads the image by digest, hands it to the runtime, and the runtime holds it", async () => {
  const { runtime, pkg, images, folder } = setup();
  expect(await pkg.install({})).toEqual({ ok: true, value: undefined });
  expect(images.downloads).toEqual([PINNED]);
  expect(existsSync(join(folder, "index.json"))).toBe(true);
  expect(runtime.loads).toEqual([IMAGE]);
  expect(runtime.loads[0]).not.toMatch(/:\d+(\.\d+)*$/);
  expect(runtime.images.has(IMAGE)).toBe(true);
});

test("start runs the image by the reference the runtime gave when it verified the image", async () => {
  const { runtime, pkg } = setup();
  await pkg.install({});
  expect((await pkg.start(startOptions)).ok).toBe(true);
  expect(runtime.starts[0]?.spec.image).toBe(IMAGE);

  const imageId = "f".repeat(64);
  const runtimeWithIds = new VerifyingRuntime();
  runtimeWithIds.verification = ok(imageId);
  runtimeWithIds.holdImage(imageId);
  const other = setup({ runtime: runtimeWithIds });
  await other.pkg.install({});
  expect((await other.pkg.start(startOptions)).ok).toBe(true);
  expect(runtimeWithIds.starts[0]?.spec.image).toBe(imageId);
});

test("a package made with the reference of an earlier install runs the image by it", async () => {
  const imageId = "e".repeat(64);
  const runtime = new FakeRuntime();
  runtime.holdImage(imageId);
  const { pkg } = setup({ runtime, imageRef: imageId });
  expect((await pkg.start(startOptions)).ok).toBe(true);
  expect(runtime.starts[0]?.spec.image).toBe(imageId);
});

test("the progress goes from the download to the load, with the variant's size until the download reports its own and then the bytes it fetches", async () => {
  const { pkg } = setup();
  const seen: InstallProgressView[] = [];
  await pkg.install({ onProgress: (progress) => seen.push(progress) });
  expect(seen[0]).toEqual({
    phase: "pulling",
    variant: "linux-amd64-cpu",
    steps: [{ id: "engine", size: 682_533_845 }],
    step: "engine",
    stepReceived: 0,
    size: 682_533_845,
    reusedBytes: 0,
    layersDone: null,
    layersTotal: null,
    speed: null,
    retries: 0,
    lastRetry: null,
  });
  expect(seen.slice(1).every((progress) => progress.size === FAKE_DOWNLOAD_SIZE && progress.reusedBytes === 0)).toBe(true);
  const phases = seen.map((progress) => progress.phase);
  expect([...new Set(phases)]).toEqual(["pulling", "loading"]);
  expect(phases.lastIndexOf("pulling")).toBeLessThan(phases.indexOf("loading"));

  const pulling = seen.filter((progress) => progress.phase === "pulling");
  const received = pulling.map((progress) => progress.stepReceived ?? 0);
  expect(received).toEqual([...received].sort((a, b) => a - b));
  expect(received.at(-1)).toBe(FAKE_DOWNLOAD_SIZE);
  expect(pulling.some((progress) => progress.layersTotal === 2)).toBe(true);
  expect(seen.at(-1)).toMatchObject({ phase: "loading", stepReceived: FAKE_DOWNLOAD_SIZE, layersDone: 2, layersTotal: 2, speed: null });
});

test("a download that fails is install.pull_failed with its cause, and nothing is loaded", async () => {
  const { runtime, pkg, images } = setup();
  images.failNext(STALLED);
  const seen: InstallProgressView[] = [];
  const result = await pkg.install({ onProgress: (progress) => seen.push(progress) });
  expect(result).toEqual({ ok: false, error: { code: "install.pull_failed", data: { cause: STALLED } } });
  expect(runtime.loads).toEqual([]);
  expect(runtime.images.size).toBe(0);
  expect(seen.every((progress) => progress.phase === "pulling")).toBe(true);
  expect(pkg.installedAs(installedRecord())).toEqual(installedRecord());
});

test("a load that fails is install.load_failed with the tool's exit code, and the download stays for the next try", async () => {
  const { runtime, pkg, folder } = setup();
  runtime.failNextLoads(1);
  const result = await pkg.install({});
  expect(result).toEqual({
    ok: false,
    error: { code: "install.load_failed", data: { exitCode: 1 } },
  });
  expect(runtime.images.has(IMAGE)).toBe(false);
  expect(existsSync(join(folder, "index.json"))).toBe(true);
  expect(pkg.installedAs(installedRecord())).toEqual(installedRecord());

  expect((await pkg.install({})).ok).toBe(true);
  expect(runtime.loads).toEqual([IMAGE, IMAGE]);
  expect(runtime.images.has(IMAGE)).toBe(true);
});

test("an image the runtime cannot vouch for after the load is install.image_not_verified, a message of its own", async () => {
  const runtime = new VerifyingRuntime();
  const cause: ApiError = { code: "runtime.image_not_verified", data: { name: localName(PINNED) } };
  runtime.verification = fail("runtime.image_not_verified", cause.data);
  const { pkg } = setup({ runtime });
  expect(await pkg.install({})).toEqual({ ok: false, error: { code: "install.image_not_verified", data: {} } });
  expect(pkg.installedAs(installedRecord())).toEqual(installedRecord());
});

test("a download that is stopped by the signal ends the install as a failed download and loads nothing", async () => {
  const { runtime, pkg } = setup();
  const abort = new AbortController();
  abort.abort();
  const result = await pkg.install({ signal: abort.signal });
  expect(result).toEqual({ ok: false, error: { code: "install.pull_failed", data: { cause: { code: "download.cancelled", data: {} } } } });
  expect(runtime.loads).toEqual([]);
});

function installedRecord(): InstalledContainerPackage {
  return { packageVersion: "2.5.0", variant: "linux-amd64-cpu", runtime: "podman", container: VARIANT };
}

test("installedAs adds the reference of the loaded image after an install, and gives the record back as it is before", async () => {
  const { pkg } = setup();
  const before = installedRecord();
  expect(pkg.installedAs(before)).toBe(before);
  await pkg.install({});
  expect(pkg.installedAs(installedRecord())).toEqual({ ...installedRecord(), imageRef: IMAGE, layers: FAKE_LAYERS });
});

test("installedAs carries the image ID that the runtime gave", async () => {
  const imageId = "d".repeat(64);
  const runtime = new VerifyingRuntime();
  runtime.verification = ok(imageId);
  const { pkg } = setup({ runtime });
  await pkg.install({});
  expect(pkg.installedAs(installedRecord())).toEqual({ ...installedRecord(), imageRef: imageId, layers: FAKE_LAYERS });
});

test("discardDownload deletes the download folder and leaves the image in the runtime", async () => {
  const { runtime, pkg, folder } = setup();
  await pkg.install({});
  expect(existsSync(folder)).toBe(true);
  pkg.discardDownload();
  expect(existsSync(folder)).toBe(false);
  expect(runtime.images.has(IMAGE)).toBe(true);
  expect(runtime.removedImages).toEqual([]);
  // Nothing there is fine too.
  pkg.discardDownload();
});

test("removeImage deletes the download folder and removes the image from the runtime", async () => {
  const { runtime, pkg, folder } = setup();
  await pkg.install({});
  expect((await pkg.removeImage()).ok).toBe(true);
  expect(existsSync(folder)).toBe(false);
  expect(runtime.removedImages).toEqual([IMAGE]);
  expect(runtime.images.has(IMAGE)).toBe(false);
});

test("removeImage removes a loaded image by the name aidm-ui gave it, which leaves alone any other name of the same image", async () => {
  const runtime = new VerifyingRuntime();
  runtime.verification = ok("c".repeat(64));
  const { pkg } = setup({ runtime });
  await pkg.install({});
  expect((await pkg.removeImage()).ok).toBe(true);
  expect(runtime.removedImages).toEqual([localName(PINNED)]);
});

test("with too little free disk nothing is downloaded, and both sizes are given", async () => {
  const free = 700_000_000;
  const { runtime, pkg, images } = setup({ free });
  const expected = { ok: false as const, error: { code: "install.not_enough_space" as const, data: { needed: neededFor(runtime), free } } };
  expect(await pkg.preflight()).toEqual(expected);
  expect(await pkg.install({})).toEqual(expected);
  expect(images.downloads).toEqual([]);
  expect(runtime.loads).toEqual([]);
});

test("the free space is measured in the data folder when the runtime does not say where it keeps its images", async () => {
  const { pkg, asked, dataFolder } = setup({ storagePath: null });
  await pkg.preflight();
  expect(asked).toEqual([dataFolder]);
});

test("when the runtime keeps its images on the disk of the data folder, that disk is measured once and has to hold both", async () => {
  const { runtime, pkg, asked, dataFolder } = setup({ storagePath: tmpdir(), free: 1 });
  const result = await pkg.preflight();
  expect(asked).toEqual([dataFolder]);
  expect(result).toEqual({ ok: false, error: { code: "install.not_enough_space", data: { needed: neededFor(runtime), free: 1 } } });
});

test("exactly the room for the download, the runtime's copies and the unpacked layers is enough, and a byte less is not", async () => {
  const runtime = new FakeRuntime();
  expect((await setup({ runtime, free: neededFor(runtime) }).pkg.preflight()).ok).toBe(true);
  const short = await setup({ runtime: new FakeRuntime(), free: neededFor(runtime) - 1 }).pkg.preflight();
  expect(short).toMatchObject({ ok: false, error: { code: "install.not_enough_space" } });
});

test("bytes of the download that are already on disk are not counted again", async () => {
  const onDisk = 5_000_000;
  const free = 1;
  const { runtime, pkg, folder } = setup({ free });
  const before = await pkg.preflight();
  leavePartOfDownload(folder, onDisk);
  const after = await pkg.preflight();
  expect(before).toEqual({ ok: false, error: { code: "install.not_enough_space", data: { needed: neededFor(runtime), free } } });
  expect(after).toEqual({ ok: false, error: { code: "install.not_enough_space", data: { needed: neededFor(runtime, onDisk), free } } });
});

test("with part of the download on disk, exactly the room for the rest is enough", async () => {
  const onDisk = 7_000_000;
  const runtime = new FakeRuntime();
  const { pkg, folder } = setup({ runtime, free: neededFor(runtime, onDisk) });
  leavePartOfDownload(folder, onDisk);
  expect((await pkg.preflight()).ok).toBe(true);
});

test("start publishes on the loopback address, mounts the data folder and the config folder, and names the config file after the image", async () => {
  const { runtime, pkg, dataFolder } = setup();
  await pkg.install({});
  const started = await pkg.start({ ...startOptions, hostPort: 45123 });
  expect(started).toEqual({ ok: true, value: { address: "http://127.0.0.1:45123" } });
  const spec = runtime.starts[0]?.spec;
  expect(spec).toMatchObject({
    name: "aidm-local-engine",
    image: IMAGE,
    publish: { hostAddress: "127.0.0.1", hostPort: 45123, containerPort: 3000 },
    mounts: [
      { hostPath: "/data/engine-data", containerPath: "/var/www/data", readOnly: false },
      { hostPath: containerConfigFolder(dataFolder), containerPath: "/etc/aidm-ui", readOnly: true },
    ],
    memoryBytes: 4 * GiB,
    cpus: 2,
    gpu: false,
    args: ["--config", "/etc/aidm-ui/task-api.json"],
  });
});

test("the token is in a private config file and not in anything the runtime is given", async () => {
  const { runtime, pkg, dataFolder } = setup();
  await pkg.install({});
  expect((await pkg.start(startOptions)).ok).toBe(true);
  const folder = containerConfigFolder(dataFolder);
  const file = join(folder, ENGINE_CONFIG_FILE_NAME);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token: "t0ken", port: 3000, parallelQueueProcessing: 1 });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(folder).mode & 0o777).toBe(0o700);
  expect(existsSync(`${file}.new`)).toBe(false);
  expect(JSON.stringify(runtime.starts[0]?.spec)).not.toContain("t0ken");
  expect(runtime.starts[0]?.argv.join(" ")).not.toContain("t0ken");
});

test("the engine answers with the token from the config file", async () => {
  const { runtime, pkg } = setup();
  await pkg.install({});
  expect((await pkg.start({ ...startOptions, token: "from-the-file" })).ok).toBe(true);
  const api = runtime.engine(CONTAINER_NAME);
  const address = api?.address ?? "";
  const right = (await (await fetch(`${address}/info?token=from-the-file`)).json()) as { error?: string };
  const wrong = (await (await fetch(`${address}/info?token=t0ken`)).json()) as { error?: string };
  expect(right.error).toBeUndefined();
  expect(wrong.error).toBe(WRONG_TOKEN_MESSAGE);
});

test("a second start with a new token rewrites the config file", async () => {
  const { pkg, dataFolder } = setup();
  await pkg.install({});
  await pkg.start(startOptions);
  await pkg.start({ ...startOptions, token: "second-token" });
  const file = join(containerConfigFolder(dataFolder), ENGINE_CONFIG_FILE_NAME);
  expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("second-token");
});

test("start tightens a config folder that already exists with looser rights", async () => {
  const { pkg, dataFolder } = setup();
  await pkg.install({});
  await pkg.start(startOptions);
  const folder = containerConfigFolder(dataFolder);
  chmodSync(folder, 0o755);
  await pkg.start(startOptions);
  expect(statSync(folder).mode & 0o777).toBe(0o700);
});

test("a config file that cannot be written is a message code and no container starts", async () => {
  const { runtime, pkg, dataFolder } = setup();
  await pkg.install({});
  // A file where the folder should be makes the write fail on every platform.
  writeFileSync(join(dataFolder, "engine-config"), "not a folder");
  const result = await pkg.start(startOptions);
  expect(result).toEqual({ ok: false, error: { code: "local.engine_config_write_failed", data: {} } });
  expect(runtime.starts).toHaveLength(0);
});

test("a container left from an earlier start is removed first, running or not", async () => {
  const { runtime, pkg } = setup();
  await pkg.install({});
  expect((await pkg.start(startOptions)).ok).toBe(true);
  expect(runtime.removals).toEqual([]);
  expect((await pkg.start(startOptions)).ok).toBe(true);
  expect(runtime.removals).toEqual([CONTAINER_NAME]);
  await runtime.kill(CONTAINER_NAME);
  expect((await pkg.start(startOptions)).ok).toBe(true);
  expect(runtime.removals).toEqual([CONTAINER_NAME, CONTAINER_NAME]);
  expect(runtime.starts).toHaveLength(3);
});

test("status, stop and logs reach the container by its fixed name", async () => {
  const { runtime, pkg } = setup();
  await pkg.install({});
  expect(await pkg.status()).toEqual({ ok: true, value: { state: "missing", exitCode: null } });
  await pkg.start(startOptions);
  expect(await pkg.status()).toEqual({ ok: true, value: { state: "running", exitCode: null } });
  runtime.emitLog(CONTAINER_NAME, "hello");
  const lines: string[] = [];
  await pkg.logs({ follow: false, onLine: (line) => lines.push(line) });
  expect(lines).toEqual(["hello"]);
  expect((await pkg.stop()).ok).toBe(true);
  expect(runtime.stops).toEqual([CONTAINER_NAME]);
  expect(await pkg.status()).toEqual({ ok: true, value: { state: "stopped", exitCode: 0 } });
});

test("remove takes away the container and the image", async () => {
  const { runtime, pkg } = setup();
  await pkg.install({});
  await pkg.start(startOptions);
  expect((await pkg.remove()).ok).toBe(true);
  expect(runtime.removals).toEqual([CONTAINER_NAME]);
  expect(runtime.removedImages).toEqual([IMAGE]);
  expect(await pkg.status()).toEqual({ ok: true, value: { state: "missing", exitCode: null } });
});

test("remove deletes the config folder with the token, and removing the container alone leaves it", async () => {
  const { pkg, dataFolder } = setup();
  await pkg.install({});
  await pkg.start(startOptions);
  const folder = containerConfigFolder(dataFolder);
  expect((await pkg.removeContainer()).ok).toBe(true);
  expect(existsSync(folder)).toBe(true);
  expect((await pkg.remove()).ok).toBe(true);
  expect(existsSync(folder)).toBe(false);
});

/** Deterministic bytes that differ from one seed to the next. */
function bytesOf(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + (i >> 8) * seed + seed) & 0xff);
}

/** A fake registry on a local port with an image of two layers (v1) and its successor with the same two and a third (v2). */
async function registryWithTwoVersions() {
  const server = new FakeFileServer();
  const registry = new FakeRegistry();
  server.registry = registry;
  await server.start();
  servers.push(server);
  const path = "aidronemap/aidm-api";
  const repository = `${new URL(server.url("")).host}/${path}`;
  const lower = bytesOf(120_000, 2);
  const middle = bytesOf(90_000, 3);
  const top = bytesOf(40_000, 4);
  const v1 = registry.addImage({ repository: path, config: bytesOf(500, 11), layers: [lower, middle] });
  const v2 = registry.addImage({ repository: path, config: bytesOf(600, 12), layers: [lower, middle, top] });
  const variant = (added: typeof v1): ContainerVariant => ({ kind: "container", image: repository, digest: added.digest, size: added.size, gpu: false });
  /** The blobs asked of the registry itself (not its signed addresses), after the first `since` requests. A request without a token is the registry's challenge and is not counted. */
  const blobsAsked = (since = 0) =>
    registry.requests
      .slice(since)
      .filter((r) => r.authorization !== null && decodeURIComponent(r.path).includes("/blobs/"))
      .map((r) => decodeURIComponent(r.path).split("/blobs/")[1] ?? "");
  return { registry, repository, v1, v2, variant, sizes: { lower: lower.length, middle: middle.length, top: top.length }, blobsAsked };
}

function registryPackage(runtime: FakeRuntime, variant: ContainerVariant, known: InstalledContainerPackage[] = []) {
  runtimes.push(runtime);
  const dataFolder = mkdtempSync(join(tmpdir(), "aidm-container-package-"));
  folders.push(dataFolder);
  const logged: string[] = [];
  const pkg = new ContainerPackage({
    runtime,
    variant,
    variantId: "linux-amd64-cpu",
    freeBytes: () => 100 * GiB,
    storagePath: null,
    dataFolder,
    known: () => known,
    download: { backoffMs: () => 10, idleMs: 1000, stallMs: 5000 },
    log: (line) => logged.push(line),
  });
  return { pkg, logged };
}

/** The record of a container package, as installedAs gives it. */
function containerRecord(record: InstalledPackage): InstalledContainerPackage {
  if (isNativePackage(record)) throw new Error("Expected a container package.");
  return record;
}

const recordOf = (variant: ContainerVariant): InstalledContainerPackage => ({ packageVersion: "2.5.0", variant: "linux-amd64-cpu", runtime: "podman", container: variant });

test("an update whose lower layers the runtime holds downloads only the config and the new layer, and shows what it reuses", async () => {
  const { registry, v1, v2, variant, sizes, blobsAsked } = await registryWithTwoVersions();
  const runtime = new FakeRuntime();

  // The first image goes in whole, and its record keeps its layers.
  const first = registryPackage(runtime, variant(v1));
  expect((await first.pkg.install({})).ok).toBe(true);
  const installed = containerRecord(first.pkg.installedAs(recordOf(variant(v1))));
  expect(installed.layers).toEqual(v1.layerDigests.map((digest, i) => ({ digest, size: i === 0 ? sizes.lower : sizes.middle })));
  expect(blobsAsked()).toEqual([v1.configDigest, ...v1.layerDigests]);
  const before = registry.requests.length;

  const second = registryPackage(runtime, variant(v2), [installed]);
  const seen: InstallProgressView[] = [];
  const result = await second.pkg.install({ onProgress: (progress) => seen.push(progress) });
  expect(result).toEqual({ ok: true, value: undefined });

  // The registry saw blob requests for v2's config and its third layer, nothing else.
  expect(blobsAsked(before)).toEqual([v2.configDigest, v2.layerDigests[2] ?? ""]);
  expect(runtime.loads).toHaveLength(2);
  expect(runtime.images.has(`${variant(v2).image}@${v2.digest}`)).toBe(true);

  // The progress counts what the download fetches and says what it did not.
  const fetched = 600 + sizes.top;
  const reused = sizes.lower + sizes.middle;
  const pulling = seen.filter((progress) => progress.phase === "pulling" && progress.layersTotal !== null);
  expect(pulling.length).toBeGreaterThan(0);
  expect(pulling.every((progress) => progress.size === fetched && progress.reusedBytes === reused && progress.layersTotal === 2)).toBe(true);
  expect(pulling.at(-1)?.stepReceived).toBe(fetched);
  expect(seen.at(-1)).toMatchObject({ phase: "loading", size: fetched, reusedBytes: reused });
  expect(second.logged.some((line) => line.includes("2 of 3 layers already held by the runtime"))).toBe(true);

  // The record of the new package lists all three layers.
  expect(containerRecord(second.pkg.installedAs(recordOf(variant(v2)))).layers?.map((layer) => layer.digest)).toEqual(v2.layerDigests);
});

test("a load that fails without the layers it should hold is tried once more with them downloaded", async () => {
  const { v2, variant, sizes, blobsAsked } = await registryWithTwoVersions();
  const runtime = new FakeRuntime();
  // The package is told that the runtime holds the two lower layers. It does not really.
  runtime.heldAnswer = new Set(v2.layerDigests.slice(0, 2));
  const { pkg, logged } = registryPackage(runtime, variant(v2));
  const seen: InstallProgressView[] = [];

  const result = await pkg.install({ onProgress: (progress) => seen.push(progress) });
  expect(result).toEqual({ ok: true, value: undefined });
  expect(runtime.loads).toHaveLength(2);
  expect(runtime.images.has(`${variant(v2).image}@${v2.digest}`)).toBe(true);

  // Each blob was fetched once: the first round left two out, the second fetched just those.
  const [lowest = "", middle = "", top = ""] = v2.layerDigests;
  expect(blobsAsked()).toEqual([v2.configDigest, top, lowest, middle]);
  expect(logged.some((line) => line.includes("did not take the image without 2 layers"))).toBe(true);
  expect(seen.some((progress) => progress.reusedBytes === sizes.lower + sizes.middle)).toBe(true);
  expect(seen.at(-1)).toMatchObject({ phase: "loading", reusedBytes: 0 });
  expect(containerRecord(pkg.installedAs(recordOf(variant(v2)))).layers).toHaveLength(3);
});

test("a second load that fails too is the load failure, with no third try", async () => {
  const { v2, variant } = await registryWithTwoVersions();
  const runtime = new FakeRuntime();
  runtime.heldAnswer = new Set(v2.layerDigests.slice(0, 2));
  runtime.failNextLoads(2);
  const { pkg } = registryPackage(runtime, variant(v2));
  expect(await pkg.install({})).toEqual({ ok: false, error: { code: "install.load_failed", data: { exitCode: 1 } } });
  expect(runtime.loads).toHaveLength(2);
});

test("a load that fails when nothing was left out is not tried again", async () => {
  const { v2, variant } = await registryWithTwoVersions();
  const runtime = new FakeRuntime();
  runtime.failNextLoads(1);
  const { pkg } = registryPackage(runtime, variant(v2));
  expect((await pkg.install({})).ok).toBe(false);
  expect(runtime.loads).toHaveLength(1);
});

test("an image that fails its check after a load without layers is loaded and checked once more", async () => {
  const { v2, variant } = await registryWithTwoVersions();
  const runtime = new UnverifiedOnce();
  // The runtime really holds the two lower layers, so the first load takes the image; only its check fails.
  runtime.holdImage("an-older-image", v2.layerDigests.slice(0, 2).map((digest) => ({ digest, size: 1 })));
  const { pkg } = registryPackage(runtime, variant(v2));
  expect(await pkg.install({})).toEqual({ ok: true, value: undefined });
  expect(runtime.loads).toHaveLength(2);
});

test("a record without layers gets them from its manifest at the registry", async () => {
  const { registry, v1, v2, variant, blobsAsked } = await registryWithTwoVersions();
  const runtime = new FakeRuntime();
  const first = registryPackage(runtime, variant(v1));
  expect((await first.pkg.install({})).ok).toBe(true);
  // An install from before the layers were recorded.
  const old = recordOf(variant(v1));
  expect(old.layers).toBeUndefined();
  const before = registry.requests.length;

  const second = registryPackage(runtime, variant(v2), [old]);
  expect((await second.pkg.install({})).ok).toBe(true);
  const manifests = registry.requests.slice(before).filter((r) => decodeURIComponent(r.path).includes(`/manifests/${v1.digest}`));
  expect(manifests.length).toBeGreaterThan(0);
  // Only the config and the third layer of v2 came in the second install.
  expect(blobsAsked(before)).toEqual([v2.configDigest, v2.layerDigests[2] ?? ""]);
});

test("a record whose layers cannot be had is left out, and the image is downloaded whole", async () => {
  const { v1, v2, variant, blobsAsked } = await registryWithTwoVersions();
  const runtime = new FakeRuntime();
  const gone = { ...recordOf({ ...variant(v1), digest: `sha256:${"0".repeat(64)}` }) };
  const { pkg } = registryPackage(runtime, variant(v2), [gone]);
  expect((await pkg.install({})).ok).toBe(true);
  expect(blobsAsked()).toEqual([v2.configDigest, ...v2.layerDigests]);
});


test("an imported folder is mounted read-only beneath the API images root", async () => {
  const { pkg, runtime, dataFolder } = setup();
  runtime.images.add(IMAGE);
  expect((await pkg.start({ ...startOptions, importFolders: ["/photos/flight"] })).ok).toBe(true);
  const spec = runtime.starts[0]!.spec;
  const imported = spec.mounts.find(mount => mount.hostPath === "/photos/flight");
  expect(imported).toMatchObject({ readOnly: true });
  expect(imported!.containerPath.startsWith("/aidm-imports/")).toBe(true);
  const config = JSON.parse(readFileSync(join(containerConfigFolder(dataFolder), ENGINE_CONFIG_FILE_NAME), "utf8"));
  expect(config.imagesRoot).toBe("/aidm-imports");
});
