import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localName, type DownloadedImage } from "../server/images/image-download.ts";
import type { ContainerSpec } from "../server/runtimes/runtime.ts";
import { FakeRuntime } from "./fake-runtime.ts";

const REPOSITORY = "ghcr.io/aidronemap/aidm-api";
const DIGEST = "sha256:" + "a".repeat(64);
const IMAGE = `${REPOSITORY}@${DIGEST}`;
const NAME = "aidm-engine";

const runtimes: FakeRuntime[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.remove(NAME);
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A spec whose task API reads its token from a config file in a mounted folder, as the real one does. */
function specWithConfig(content: string | null, patch: Partial<ContainerSpec> = {}): ContainerSpec {
  const folder = mkdtempSync(join(tmpdir(), "aidm-fake-runtime-"));
  folders.push(folder);
  if (content !== null) writeFileSync(join(folder, "task-api.json"), content);
  return spec({
    mounts: [{ hostPath: folder, containerPath: "/etc/aidm-ui", readOnly: true }],
    args: ["--config", "/etc/aidm-ui/task-api.json"],
    ...patch,
  });
}

/** An image as the downloader leaves it. The fake runtime reads nothing from its folder. */
function downloaded(digest = DIGEST): DownloadedImage {
  const pinned = { repository: REPOSITORY, digest };
  return {
    pinned,
    folder: "/home/operator/downloads/image",
    name: localName(pinned),
    manifest: { digest, size: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" },
    config: { digest: "sha256:" + "c".repeat(64), size: 2 },
    layers: [{ digest: "sha256:" + "1".repeat(64), size: 10 }],
    skipped: [],
  };
}

function fake(options?: ConstructorParameters<typeof FakeRuntime>[0]): FakeRuntime {
  const runtime = new FakeRuntime(options);
  runtimes.push(runtime);
  return runtime;
}

function spec(patch: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: NAME,
    image: IMAGE,
    platform: null,
    publish: { hostAddress: "127.0.0.1", hostPort: 0, containerPort: 3000 },
    mounts: [{ hostPath: "/home/operator/engine-data", containerPath: "/var/www/data", readOnly: false }],
    memoryBytes: 4 * 1024 ** 3,
    cpus: 2,
    gpu: false,
    args: ["--token", "run-token", "--port", "3000"],
    ...patch,
  };
}

async function started(runtime: FakeRuntime, patch: Partial<ContainerSpec> = {}) {
  runtime.holdImage(IMAGE);
  const result = await runtime.start(spec(patch));
  if (!result.ok) throw new Error(`start failed: ${result.error.code}`);
  return result.value;
}

test("by default it is an available Podman 5.8.9 that enforces the memory cap", async () => {
  expect(await fake().detect()).toEqual({
    id: "podman",
    available: true,
    version: "5.8.9",
    memoryCapEnforced: true,
    cpuCapEnforced: true,
    storagePath: null,
    problem: null,
  });
});

test("the detection can be changed, and the id picked", async () => {
  const runtime = fake({ id: "docker", detection: { memoryCapEnforced: false } });
  expect(runtime.id).toBe("docker");
  expect(await runtime.detect()).toMatchObject({ id: "docker", available: true, memoryCapEnforced: false });
});

test("a load remembers the image by its pinned reference, and the image can then be verified and started", async () => {
  const runtime = fake();
  expect(await runtime.load(downloaded())).toEqual({ ok: true, value: undefined });
  expect(runtime.images.has(IMAGE)).toBe(true);
  expect(runtime.loads).toEqual([IMAGE]);
  // The reference to run the image by is the pinned one, so a start carries "<image>@<digest>".
  expect(await runtime.verifyImage(downloaded())).toEqual({ ok: true, value: IMAGE });
  expect((await runtime.start(spec())).ok).toBe(true);
});

test("an image that was never loaded is not verified, even when an image of that reference was put in place", async () => {
  const runtime = fake();
  const missing = { ok: false as const, error: { code: "runtime.image_not_verified" as const, data: { name: localName(downloaded().pinned) } } };
  expect(await runtime.verifyImage(downloaded())).toEqual(missing);
  runtime.holdImage(IMAGE);
  expect(await runtime.verifyImage(downloaded())).toEqual(missing);
});

test("an image of another digest is not verified by the load of this one", async () => {
  const runtime = fake();
  await runtime.load(downloaded());
  const other = downloaded("sha256:" + "b".repeat(64));
  expect((await runtime.verifyImage(other)).ok).toBe(false);
});

test("a failed load leaves the image absent but is recorded, and the next one works", async () => {
  const runtime = fake();
  runtime.failNextLoads(2);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await runtime.load(downloaded())).toEqual({ ok: false, error: { code: "runtime.load_failed", data: { exitCode: 1 } } });
    expect(runtime.images.has(IMAGE)).toBe(false);
  }
  expect((await runtime.load(downloaded())).ok).toBe(true);
  expect(runtime.loads).toEqual([IMAGE, IMAGE, IMAGE]);
  expect(runtime.images.has(IMAGE)).toBe(true);
});

test("it holds the layers of the images it loaded or was given, and answers which of some layers they are", async () => {
  const runtime = fake();
  const layer = (character: string) => ({ digest: "sha256:" + character.repeat(64), size: 10 });
  const [a, b, c] = [layer("1"), layer("2"), layer("3")] as [ReturnType<typeof layer>, ReturnType<typeof layer>, ReturnType<typeof layer>];
  expect(await runtime.heldLayers([a, b, c], [])).toEqual(new Set());
  await runtime.load({ ...downloaded(), layers: [a, b] });
  expect(await runtime.heldLayers([a, b, c], [])).toEqual(new Set([a.digest, b.digest]));
  runtime.holdImage("other", [c]);
  expect(await runtime.heldLayers([c], [{ ref: "x", layers: [] }])).toEqual(new Set([c.digest]));
  expect(runtime.heldAsks.map((ask) => ask.known)).toEqual([[], [], ["x"]]);
  runtime.heldAnswer = new Set([a.digest]);
  expect(await runtime.heldLayers([a, b, c], [])).toEqual(new Set([a.digest]));
});

test("a load that leaves out a layer it does not hold fails, as the real tools do", async () => {
  const runtime = fake();
  const layer = { digest: "sha256:" + "4".repeat(64), size: 10 };
  const image = { ...downloaded(), layers: [layer], skipped: [layer] };
  expect(await runtime.load(image)).toEqual({ ok: false, error: { code: "runtime.load_failed", data: { exitCode: 1 } } });
  expect(runtime.images.size).toBe(0);
  runtime.holdImage("older", [layer]);
  expect(await runtime.load(image)).toEqual({ ok: true, value: undefined });
});

test("a load with a signal that has fired fails as cancelled and leaves the image absent", async () => {
  const runtime = fake();
  const controller = new AbortController();
  controller.abort();
  expect(await runtime.load(downloaded(), { signal: controller.signal })).toEqual({ ok: false, error: { code: "download.cancelled", data: {} } });
  expect(runtime.images.has(IMAGE)).toBe(false);
});

test("a load makes one copy of the download on the runtime's disk", () => {
  expect(fake().loadCopies).toBe(1);
});

test("a container cannot start from an image that was never loaded", async () => {
  expect(await fake().start(spec())).toEqual({ ok: false, error: { code: "runtime.image_not_found", data: {} } });
});

test("a container cannot start under a name in use", async () => {
  const runtime = fake();
  await started(runtime);
  expect(await runtime.start(spec())).toEqual({ ok: false, error: { code: "runtime.name_in_use", data: { name: NAME } } });
});

test("a container cannot start on a port in use", async () => {
  const runtime = fake();
  await started(runtime);
  const port = Number(new URL(runtime.engine(NAME)!.address).port);
  runtime.holdImage(IMAGE);
  const result = await runtime.start(spec({ name: "other", publish: { hostAddress: "127.0.0.1", hostPort: port, containerPort: 3000 } }));
  expect(result).toEqual({ ok: false, error: { code: "runtime.port_in_use", data: { port } } });
});

test("a started container runs a task API that wants the token from its config file", async () => {
  const runtime = fake();
  runtime.holdImage(IMAGE);
  const result = await runtime.start(specWithConfig(JSON.stringify({ token: "run-token", port: 3000 })));
  if (!result.ok) throw new Error(`start failed: ${result.error.code}`);
  expect(result.value.containerId).toMatch(/^[0-9a-f]{64}$/);
  const engine = runtime.engine(NAME)!;
  expect(engine.token).toBe("run-token");
  const good = await (await fetch(`${engine.address}/info?token=run-token`)).json();
  expect(good).toMatchObject({ version: "2.5.0" });
  const bad = await (await fetch(`${engine.address}/info?token=wrong`)).json();
  expect(bad).toHaveProperty("error");
  expect(await runtime.status(NAME)).toEqual({ ok: true, value: { state: "running", exitCode: null, oomKilled: false } });
});

test("the version its task API reports comes from the image, when a function says so", async () => {
  const runtime = fake({ versionOf: (image) => (image === IMAGE ? "2.6.0" : "2.5.0") });
  await started(runtime);
  const engine = runtime.engine(NAME)!;
  expect(await (await fetch(`${engine.address}/info?token=fake-token`)).json()).toMatchObject({ version: "2.6.0" });
});

test("a silent image starts a container whose engine never answers", async () => {
  const runtime = fake({ silent: (image) => image === IMAGE });
  const { containerId } = await started(runtime, { publish: { hostAddress: "127.0.0.1", hostPort: 45987, containerPort: 3000 } });
  expect(containerId).toMatch(/^[0-9a-f]{64}$/);
  expect(await runtime.status(NAME)).toEqual({ ok: true, value: { state: "running", exitCode: null, oomKilled: false } });
  await expect(fetch("http://127.0.0.1:45987/info?token=run-token")).rejects.toThrow();
});

test("the start command it recorded is the real Podman command line, or Docker's", async () => {
  const podman = fake();
  await started(podman, { publish: { hostAddress: "127.0.0.1", hostPort: 0, containerPort: 3000 } });
  const argv = podman.starts[0]!.argv;
  expect(argv.slice(0, 6)).toEqual(["podman", "run", "-d", "--pull=never", "--name", NAME]);
  expect(argv).toContain("-p");
  expect(argv).toContain("/home/operator/engine-data:/var/www/data:Z");
  expect(argv.slice(-4)).toEqual(["--token", "run-token", "--port", "3000"]);
  expect(podman.starts[0]!.spec.name).toBe(NAME);

  const docker = fake({ id: "docker" });
  await started(docker);
  expect(docker.starts[0]!.argv[0]).toBe("docker");
  expect(docker.starts[0]!.argv).toContain("/home/operator/engine-data:/var/www/data");
});

test("the recorded start command leaves the caps out when the detection says they are not enforced", async () => {
  const runtime = fake({ detection: { memoryCapEnforced: false } });
  await started(runtime);
  expect(runtime.starts[0]!.argv).not.toContain("--memory");
  expect(runtime.starts[0]!.argv).toContain("--cpus");
});

test("a kill stops the task API and leaves the container stopped with exit code 137", async () => {
  const runtime = fake();
  await started(runtime);
  const address = runtime.engine(NAME)!.address;
  await runtime.kill(NAME);
  expect(await runtime.status(NAME)).toEqual({ ok: true, value: { state: "stopped", exitCode: 137, oomKilled: false } });
  await expect(fetch(`${address}/info?token=run-token`)).rejects.toThrow();
  // The name is still held until the container is removed, as with the real tools.
  expect((await runtime.start(spec())).ok).toBe(false);
});

test("a stop and a remove stop the task API and are recorded; a remove frees the name", async () => {
  const runtime = fake();
  await started(runtime);
  const address = runtime.engine(NAME)!.address;
  expect(await runtime.stop(NAME)).toEqual({ ok: true, value: undefined });
  await expect(fetch(`${address}/info?token=run-token`)).rejects.toThrow();
  expect(runtime.stops).toEqual([NAME]);
  expect(await runtime.remove(NAME)).toEqual({ ok: true, value: undefined });
  expect(runtime.removals).toEqual([NAME]);
  expect(await runtime.status(NAME)).toEqual({ ok: true, value: { state: "missing", exitCode: null, oomKilled: null } });
  expect((await runtime.start(spec())).ok).toBe(true);
});

test("removing or stopping what is not there is fine, and an image removal is recorded", async () => {
  const runtime = fake();
  expect((await runtime.stop("nothing")).ok).toBe(true);
  expect((await runtime.remove("nothing")).ok).toBe(true);
  runtime.holdImage(IMAGE);
  expect((await runtime.removeImage(IMAGE)).ok).toBe(true);
  expect(runtime.removedImages).toEqual([IMAGE]);
  expect(runtime.images.has(IMAGE)).toBe(false);
});

test("a followed log delivers lines emitted later, until the container stops", async () => {
  const runtime = fake();
  await started(runtime);
  runtime.emitLog(NAME, "before");
  const lines: string[] = [];
  let ended = false;
  const following = runtime.logs(NAME, { follow: true, onLine: (line) => lines.push(line) }).then((result) => {
    ended = true;
    return result;
  });
  await Bun.sleep(5);
  runtime.emitLog(NAME, "after one");
  runtime.emitLog(NAME, "after two");
  expect(lines).toEqual(["before", "after one", "after two"]);
  expect(ended).toBe(false);
  await runtime.stop(NAME);
  expect(await following).toEqual({ ok: true, value: undefined });
  expect(ended).toBe(true);
});

test("a followed log ends when the container is removed or the signal fires", async () => {
  const runtime = fake();
  await started(runtime);
  const controller = new AbortController();
  const lines: string[] = [];
  const bySignal = runtime.logs(NAME, { follow: true, onLine: (line) => lines.push(line), signal: controller.signal });
  const byRemoval = runtime.logs(NAME, { follow: true, onLine: () => {} });
  controller.abort();
  expect(await bySignal).toEqual({ ok: true, value: undefined });
  runtime.emitLog(NAME, "after the signal");
  expect(lines).toEqual([]);
  await runtime.remove(NAME);
  expect(await byRemoval).toEqual({ ok: true, value: undefined });
});

test("a log without follow gives what is there, limited by tail, and returns", async () => {
  const runtime = fake();
  await started(runtime);
  for (const line of ["one", "two", "three"]) runtime.emitLog(NAME, line);
  const lines: string[] = [];
  expect((await runtime.logs(NAME, { follow: false, tail: 2, onLine: (line) => lines.push(line) })).ok).toBe(true);
  expect(lines).toEqual(["two", "three"]);
});

test("the log of a container that is not there ends at once", async () => {
  const lines: string[] = [];
  const result = await fake().logs("nothing", { follow: true, onLine: (line) => lines.push(line) });
  expect(result).toEqual({ ok: true, value: undefined });
  expect(lines).toEqual([]);
});

test("a container whose config file is missing or is not JSON is created and has already exited with status 1", async () => {
  for (const content of [null, "not json", JSON.stringify({ port: 3000 })]) {
    const runtime = fake();
    runtime.holdImage(IMAGE);
    expect((await runtime.start(specWithConfig(content))).ok).toBe(true);
    expect(await runtime.status(NAME)).toEqual({ ok: true, value: { state: "stopped", exitCode: 1, oomKilled: false } });
    await runtime.remove(NAME);
  }
});

test("a container started without a config option uses a token of its own", async () => {
  const runtime = fake();
  await started(runtime);
  expect(runtime.engine(NAME)!.token).toBe("fake-token");
});
