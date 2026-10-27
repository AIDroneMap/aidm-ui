// The local engine on a Mac reached through a Unix socket instead of a port
// (ADR 0006). Apple's tool relays the task API's socket inside the container to
// one in the data folder; the fake runtime does the same with a fake task API
// that listens on that socket, and the task client talks to it with Bun's fetch.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeImages } from "../../test-support/fake-images.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { EngineMonitor } from "../engines/engine-monitor.ts";
import { EngineStore } from "../engines/engine-store.ts";
import { TaskClient } from "../task-api/task-client.ts";
import { eventually } from "../testing/harness.ts";
import {
  CONTAINER_NAME,
  ContainerPackage,
  containerConfigFolder,
  ENGINE_CONFIG_FILE_NAME,
  engineSocketPath,
  MAX_SOCKET_PATH_BYTES,
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
const SOCKET_VARIANT: ContainerVariant = { ...VARIANT, taskApiSocket: true };
const START = { hostPort: 45123, token: "t0ken", memoryBytes: 4 * GiB, cpus: 2, engineDataFolder: "/data/engine-data", gpu: false };

const runtimes: FakeRuntime[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.engine(CONTAINER_NAME)?.stop();
    await runtime.remove(CONTAINER_NAME);
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function started(options: { runtime?: "apple-container" | "podman"; variant?: ContainerVariant; dataFolder?: string }) {
  const runtime = new FakeRuntime({ id: options.runtime ?? "apple-container" });
  runtimes.push(runtime);
  // A short folder: a Unix socket path holds 104 bytes on macOS and 108 on Linux.
  const dataFolder = options.dataFolder ?? mkdtempSync(join("/tmp", "aidm-sock-"));
  folders.push(dataFolder);
  const lines: string[] = [];
  const pkg = new ContainerPackage({
    runtime,
    variant: options.variant ?? SOCKET_VARIANT,
    variantId: "darwin-arm64",
    freeBytes: () => 100 * GiB,
    storagePath: null,
    dataFolder,
    images: new FakeImages(),
    log: (line) => lines.push(line),
  });
  expect((await pkg.install({})).ok).toBe(true);
  const result = await pkg.start(START);
  return { runtime, dataFolder, result, lines, spec: runtime.starts[0]?.spec, argv: runtime.starts[0]?.argv ?? [] };
}

test("on Apple's tool a package whose task API can use a socket publishes the socket and no port", async () => {
  const { result, spec, argv, dataFolder, lines } = await started({});
  const socket = engineSocketPath(dataFolder);
  expect(result).toEqual({ ok: true, value: { address: `unix:${socket}` } });
  expect(spec?.publish).toBeNull();
  expect(spec?.publishSocket).toEqual({ hostPath: socket, containerPath: "/run/task-api.sock" });
  expect(argv).toContain("--publish-socket");
  expect(argv[argv.indexOf("--publish-socket") + 1]).toBe(`${socket}:/run/task-api.sock`);
  expect(argv).not.toContain("-p");
  // The task API is told where to listen inside, next to its port, which only the checks from inside use.
  const config = JSON.parse(readFileSync(join(containerConfigFolder(dataFolder), ENGINE_CONFIG_FILE_NAME), "utf8"));
  expect(config).toEqual({ token: "t0ken", port: 3000, parallelQueueProcessing: 1, socket: "/run/task-api.sock" });
  expect(lines).toContain(`The engine is reached through the socket ${socket}, with no port and no network.`);
});

test("the task client reaches the engine through the socket with the token, and the token stays out of the address", async () => {
  const { result, runtime } = await started({});
  if (!result.ok) throw new Error("no start");
  const info = await new TaskClient({ address: result.value.address, token: "t0ken" }).info();
  expect(info.ok).toBe(true);
  expect(runtime.engine(CONTAINER_NAME)?.requests.at(-1)).toEqual({ method: "GET", path: "/info", token: "t0ken" });
  expect(result.value.address).not.toContain("t0ken");
});

test("a socket file left by a container that did not stop cleanly is removed before the start, which the tool would refuse", async () => {
  const dataFolder = mkdtempSync(join("/tmp", "aidm-sock-"));
  mkdirSync(join(dataFolder, "run"), { recursive: true });
  writeFileSync(engineSocketPath(dataFolder), "left over");
  const { result } = await started({ dataFolder });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect((await new TaskClient({ address: result.value.address, token: "t0ken" }).info()).ok).toBe(true);
});

test("a package that does not say its task API can use a socket keeps the published port", async () => {
  const { result, spec, argv } = await started({ variant: VARIANT });
  expect(result).toEqual({ ok: true, value: { address: "http://127.0.0.1:45123" } });
  expect(spec?.publishSocket).toBeUndefined();
  expect(argv).not.toContain("--publish-socket");
  expect(argv).toContain("-p");
});

test("Podman and Docker keep the port even for a package that can use a socket", async () => {
  const { result, argv } = await started({ runtime: "podman" });
  expect(result).toEqual({ ok: true, value: { address: "http://127.0.0.1:45123" } });
  expect(argv).not.toContain("--publish-socket");
});

test("a data folder whose socket path would be too long for macOS falls back to the port, and the log says why", async () => {
  const deep = mkdtempSync(join(tmpdir(), "aidm-sock-"));
  folders.push(deep);
  const dataFolder = join(deep, "a".repeat(90));
  mkdirSync(dataFolder, { recursive: true });
  const { result, lines } = await started({ dataFolder });
  expect(result).toEqual({ ok: true, value: { address: "http://127.0.0.1:45123" } });
  const length = Buffer.byteLength(engineSocketPath(dataFolder));
  expect(length).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
  expect(lines).toContain(
    `The engine is reached through its port: the socket path in the data folder would be ${length} bytes, and macOS allows ${MAX_SOCKET_PATH_BYTES}.`,
  );
});

test("the monitor polls a local engine through its socket and finds it ready", async () => {
  const { result } = await started({});
  if (!result.ok) throw new Error("no start");
  const db = new Database(":memory:", { strict: true });
  applyMigrations(db, migrations);
  const store = new EngineStore(db);
  const engine = store.addLocal({ name: "This computer", token: "t0ken", packageKind: "container", installedVersion: "2.7.0" });
  store.update(engine.id, { address: result.value.address });
  const monitor = new EngineMonitor({ store, intervalMs: 30, log: () => {} });
  try {
    monitor.start();
    await eventually(async () => monitor.views()[0]?.state === "ready");
  } finally {
    await monitor.stop();
    db.close();
  }
});
