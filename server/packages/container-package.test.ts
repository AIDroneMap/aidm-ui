import { afterEach, expect, test } from "bun:test";
import type { InstallProgressView } from "../../shared/api-types.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { DOWNLOAD_FREE_DISK_MARGIN } from "../machine/thresholds.ts";
import { CONTAINER_NAME, ContainerPackage, type ContainerVariant } from "./container-package.ts";

const GiB = 1024 ** 3;
const VARIANT: ContainerVariant = {
  kind: "container",
  image: "ghcr.io/aidronemap/aidm-api",
  digest: `sha256:${"a".repeat(64)}`,
  size: 682_533_845,
  gpu: false,
};
const IMAGE = `${VARIANT.image}@${VARIANT.digest}`;

const runtimes: FakeRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.remove(CONTAINER_NAME);
});

function setup(options: { free?: number; runtime?: FakeRuntime } = {}) {
  const runtime = options.runtime ?? new FakeRuntime();
  runtimes.push(runtime);
  const sleeps: number[] = [];
  const pkg = new ContainerPackage({
    runtime,
    variant: VARIANT,
    packageVersion: "2.5.0",
    freeBytes: () => options.free ?? 100 * GiB,
    dataFolder: "/data",
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { runtime, pkg, sleeps };
}

const startOptions = {
  hostPort: 0,
  token: "t0ken",
  memoryBytes: 4 * GiB,
  cpus: 2,
  engineDataFolder: "/data/engine-data",
  gpu: false,
};

test("it pulls the image by digest, never by tag", async () => {
  const { runtime, pkg } = setup();
  expect(await pkg.install({})).toEqual({ ok: true, value: undefined });
  expect(runtime.pulls).toEqual([IMAGE]);
  expect(runtime.pulls[0]).not.toMatch(/:\d+(\.\d+)*$/);
});

test("the progress carries the manifest's size, the layers, and the attempt", async () => {
  const { pkg } = setup();
  const seen: InstallProgressView[] = [];
  await pkg.install({ onProgress: (progress) => seen.push(progress) });
  expect(seen[0]).toEqual({
    phase: "pulling",
    size: 682_533_845,
    layersDone: null,
    layersTotal: null,
    attempt: 1,
    maxAttempts: 5,
  });
  expect(seen.every((progress) => progress.size === 682_533_845 && progress.phase === "pulling")).toBe(true);
  expect(seen.some((progress) => progress.layersTotal !== null && progress.layersTotal > 0)).toBe(true);
});

test("with too little free disk nothing is pulled, and both sizes are given", async () => {
  const free = 700_000_000;
  const { runtime, pkg } = setup({ free });
  const needed = Math.ceil(VARIANT.size * (1 + DOWNLOAD_FREE_DISK_MARGIN));
  const expected = { ok: false as const, error: { code: "install.not_enough_space" as const, data: { needed, free } } };
  expect(await pkg.preflight()).toEqual(expected);
  expect(await pkg.install({})).toEqual(expected);
  expect(runtime.pulls).toEqual([]);
});

test("exactly the package size plus 20 percent is enough", async () => {
  const { pkg } = setup({ free: Math.ceil(VARIANT.size * 1.2) });
  expect((await pkg.preflight()).ok).toBe(true);
});

test("an interrupted pull is tried again after 2, 4, 8 and 16 seconds, and then reported", async () => {
  const { runtime, pkg, sleeps } = setup();
  runtime.failNextPulls(5);
  const seen: InstallProgressView[] = [];
  const result = await pkg.install({ onProgress: (progress) => seen.push(progress) });
  expect(result).toMatchObject({ ok: false, error: { code: "install.pull_failed", data: { attempts: 5 } } });
  expect(runtime.pulls).toHaveLength(5);
  expect(sleeps).toEqual([2000, 4000, 8000, 16000]);
  expect(new Set(seen.map((progress) => progress.attempt))).toEqual(new Set([1, 2, 3, 4, 5]));
});

test("a pull that works on the third try completes", async () => {
  const { runtime, pkg, sleeps } = setup();
  runtime.failNextPulls(2);
  expect((await pkg.install({})).ok).toBe(true);
  expect(runtime.pulls).toHaveLength(3);
  expect(sleeps).toEqual([2000, 4000]);
});

test("a pull that is aborted is not tried again", async () => {
  const { runtime, pkg } = setup();
  const abort = new AbortController();
  abort.abort();
  const result = await pkg.install({ signal: abort.signal });
  expect(result).toMatchObject({ ok: false, error: { code: "install.pull_failed", data: { attempts: 1 } } });
  expect(runtime.pulls).toHaveLength(1);
});

test("start publishes on the loopback address, mounts the data folder and passes the arguments after the image", async () => {
  const { runtime, pkg } = setup();
  await pkg.install({});
  const started = await pkg.start({ ...startOptions, hostPort: 45123 });
  expect(started).toEqual({ ok: true, value: { address: "http://127.0.0.1:45123" } });
  const spec = runtime.starts[0]?.spec;
  expect(spec).toMatchObject({
    name: "aidm-local-engine",
    image: IMAGE,
    publish: { hostAddress: "127.0.0.1", hostPort: 45123, containerPort: 3000 },
    mounts: [{ hostPath: "/data/engine-data", containerPath: "/var/www/data" }],
    memoryBytes: 4 * GiB,
    cpus: 2,
    gpu: false,
    args: ["--port", "3000", "--token", "t0ken", "--parallel_queue_processing", "1"],
  });
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
