import { afterEach, expect, test } from "bun:test";
import type { ContainerSpec, PullProgress } from "../server/runtimes/runtime.ts";
import { FakeRuntime } from "./fake-runtime.ts";

const IMAGE = "ghcr.io/aidronemap/aidm-api@sha256:" + "a".repeat(64);
const NAME = "aidm-engine";

const runtimes: FakeRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.remove(NAME);
});

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
    mounts: [{ hostPath: "/home/operator/engine-data", containerPath: "/var/www/data" }],
    memoryBytes: 4 * 1024 ** 3,
    cpus: 2,
    gpu: false,
    args: ["--token", "run-token", "--port", "3000"],
    ...patch,
  };
}

async function started(runtime: FakeRuntime, patch: Partial<ContainerSpec> = {}) {
  await runtime.pull(IMAGE);
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
    problem: null,
  });
});

test("the detection can be changed, and the id picked", async () => {
  const runtime = fake({ id: "docker", detection: { memoryCapEnforced: false } });
  expect(runtime.id).toBe("docker");
  expect(await runtime.detect()).toMatchObject({ id: "docker", available: true, memoryCapEnforced: false });
});

test("a pull sends the recorded progress with a total, and remembers the image", async () => {
  const runtime = fake();
  const seen: PullProgress[] = [];
  expect(await runtime.pull(IMAGE, { onProgress: (progress) => seen.push(progress) })).toEqual({ ok: true, value: undefined });
  expect(seen.at(-1)).toEqual({ layersDone: 10, layersTotal: 10, phase: "writing" });
  expect(runtime.images.has(IMAGE)).toBe(true);
  expect(runtime.pulls).toEqual([IMAGE]);
});

test("a pull sends the progress it was given", async () => {
  const given: PullProgress[] = [{ layersDone: 1, layersTotal: 2, phase: "downloading" }];
  const runtime = fake({ pullOutput: given });
  const seen: PullProgress[] = [];
  await runtime.pull(IMAGE, { onProgress: (progress) => seen.push(progress) });
  expect(seen).toEqual(given);
});

test("an interrupted pull sends some progress, fails, and leaves the image absent; the next one works", async () => {
  const runtime = fake();
  runtime.failNextPulls(2);
  for (let attempt = 0; attempt < 2; attempt++) {
    const seen: PullProgress[] = [];
    const result = await runtime.pull(IMAGE, { onProgress: (progress) => seen.push(progress) });
    expect(result).toEqual({ ok: false, error: { code: "runtime.pull_failed", data: { exitCode: 1 } } });
    expect(seen.length).toBeGreaterThan(0);
    expect(runtime.images.has(IMAGE)).toBe(false);
  }
  expect((await runtime.pull(IMAGE)).ok).toBe(true);
  expect(runtime.pulls).toHaveLength(3);
});

test("a container cannot start from an image that was never pulled", async () => {
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
  await runtime.pull(IMAGE);
  const result = await runtime.start(spec({ name: "other", publish: { hostAddress: "127.0.0.1", hostPort: port, containerPort: 3000 } }));
  expect(result).toEqual({ ok: false, error: { code: "runtime.port_in_use", data: { port } } });
});

test("a started container runs a task API that wants the token from its arguments", async () => {
  const runtime = fake();
  const { containerId } = await started(runtime);
  expect(containerId).toMatch(/^[0-9a-f]{64}$/);
  const engine = runtime.engine(NAME)!;
  expect(engine.token).toBe("run-token");
  const good = await (await fetch(`${engine.address}/info?token=run-token`)).json();
  expect(good).toMatchObject({ version: "2.5.0" });
  const bad = await (await fetch(`${engine.address}/info?token=wrong`)).json();
  expect(bad).toHaveProperty("error");
  expect(await runtime.status(NAME)).toEqual({ ok: true, value: { state: "running", exitCode: null, oomKilled: false } });
});

test("the start command it recorded is the real Podman command line, or Docker's", async () => {
  const podman = fake();
  await started(podman, { publish: { hostAddress: "127.0.0.1", hostPort: 0, containerPort: 3000 } });
  const argv = podman.starts[0]!.argv;
  expect(argv.slice(0, 5)).toEqual(["podman", "run", "-d", "--name", NAME]);
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
  await runtime.pull(IMAGE);
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
