import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { LocalEngineView, VariantId } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { archiveFetch, buildNativeArchive, nativeRelease, runnerWithSystemd, type TestArchive } from "../../test-support/native-archive.ts";
import { generateSigner, signedRelease, type TestSigner } from "../../test-support/signed-manifest.ts";
import { ACCEPTED_KEYS } from "../manifest/keys.ts";
import type { Manifest } from "../manifest/schema.ts";
import { spawnEngine, type SpawnEngine } from "../packages/native-package.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

const LATEST = "/releases/latest/download/manifest.json";
const GiB = 1024 ** 3;

let fake: FakeFileServer;
let signer: TestSigner;
let harness: Harness | undefined;
const folders: string[] = [];
const strays: number[] = [];

beforeEach(async () => {
  fake = new FakeFileServer();
  await fake.start();
  signer = await generateSigner();
});

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  await fake.stop();
  for (const pid of strays.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** What a start was asked to run, and where. The program is really started, except for the wrapper of a memory limit. */
function recordingSpawn() {
  const starts: Array<{ argv: string[]; cwd: string; pid: number }> = [];
  const spawn: SpawnEngine = (argv, options) => {
    // systemd-run is never run for real: the program behind the wrapper is started directly.
    const direct = argv[0] === "systemd-run" ? argv.slice(argv.indexOf("--") + 1) : argv;
    const child = spawnEngine(direct, options);
    starts.push({ argv, cwd: options.cwd, pid: child.pid });
    return child;
  };
  return { starts, spawn };
}

type Spawner = ReturnType<typeof recordingSpawn>;

function keptFolder(): string {
  const folder = mkdtempSync(join(os.tmpdir(), "aidm-ui-native-"));
  folders.push(folder);
  return folder;
}

function start(
  spawner: Spawner,
  options: { timeoutMs?: number; harness?: Parameters<typeof openHarness>[0] } = {},
): Harness {
  harness = openHarness({
    enginePollMs: 50,
    runPollMs: 30,
    // No container tool at all: a native package needs none.
    runtimes: {},
    updateReadyTimeoutMs: options.timeoutMs ?? 3000,
    manifest: { releasesUrl: fake.url("/releases"), keys: [signer.key, ...ACCEPTED_KEYS], fetch: (url, init) => fetch(url, init) },
    native: { spawn: spawner.spawn, fetch: archiveFetch((path) => fake.url(path)) },
    ...options.harness,
  });
  return harness;
}

async function publish(archive: TestArchive, sequence: number, overrides: Partial<Manifest> = {}, variant?: VariantId): Promise<void> {
  const manifest = nativeRelease(archive, sequence, overrides, variant);
  const { bytes, signature } = await signedRelease(signer, manifest);
  const tag = `v${archive.version}`;
  fake.files.set(archive.path, archive.bytes);
  fake.files.set(`/releases/download/${tag}/manifest.json`, bytes);
  fake.files.set(`/releases/download/${tag}/manifest.json.sig`, signature);
  fake.redirects.set(LATEST, `/releases/download/${tag}/manifest.json`);
}

const send = (h: Harness, method: string, path: string) => fetch(`${h.base}${path}`, { method });
const localView = async (h: Harness) => (await (await send(h, "GET", "/api/local-engine")).json()) as LocalEngineView;
const errorOf = async (response: Response) => ((await response.json()) as { error: ApiError }).error;

/** Publishes a release and asks for it, the way the operator's check does. */
async function offer(h: Harness, archive: TestArchive, sequence: number, variant?: VariantId): Promise<void> {
  await publish(archive, sequence, {}, variant);
  const refreshed = (await (await send(h, "POST", "/api/packages/refresh")).json()) as { result: { ok: boolean } };
  expect(refreshed.result.ok).toBe(true);
}

async function installAndWaitReady(h: Harness): Promise<void> {
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");
}

async function runningVersion(h: Harness): Promise<string | undefined> {
  const list = (await (await send(h, "GET", "/api/engines")).json()) as Array<{ kind: string; state: string; info: { version: string } | null }>;
  const local = list.find((engine) => engine.kind === "local");
  return local?.state === "ready" ? local.info?.version : undefined;
}

async function untilCurrent(h: Harness, version: string): Promise<void> {
  await eventually(async () => (await localView(h)).installed?.packageVersion === version && (await localView(h)).update.applying === null);
  await eventually(async () => (await runningVersion(h)) === version);
}

async function updateTo(h: Harness, version: string): Promise<void> {
  expect((await send(h, "POST", "/api/local-engine/update")).status).toBe(202);
  await untilCurrent(h, version);
}

const packageFolders = (h: Harness) => readdirSync(join(h.dataFolder, "engine-packages")).sort();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Criterion: a native entry in a signed test manifest is downloaded, verified, unpacked and started by the fake, and the engines page shows the local engine ready.

test("a native entry in a signed manifest is downloaded, verified, unpacked and started, and the engine is ready", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const h = start(spawner);
  await publish(archive, 2);
  await send(h, "POST", "/api/packages/refresh");
  const packages = (await (await send(h, "GET", "/api/packages")).json()) as { offer: { kind: string; packageVersion: string } };
  expect(packages.offer).toMatchObject({ kind: "native", packageVersion: "2.6.0" });

  await installAndWaitReady(h);

  const view = await localView(h);
  expect(view.installed).toEqual({ packageVersion: "2.6.0", variant: "linux-amd64-cpu", kind: "native", runtime: null });
  expect(view.problem).toBeNull();
  expect(view.runtime.chosen).toBeNull();
  expect(h.engineStore.local()?.packageKind).toBe("native");
  expect(h.engineStore.local()?.installedVersion).toBe("2.6.0");
  expect(await runningVersion(h)).toBe("2.6.0");

  // One folder for the version; the archive and the temporary folder are gone.
  expect(packageFolders(h)).toEqual(["2.6.0"]);
  expect(existsSync(join(h.dataFolder, "engine-packages", "2.6.0", "aidm-api"))).toBe(true);
  expect(readdirSync(join(h.dataFolder, "downloads"))).toEqual([]);
  expect(fake.requests.filter((request) => request.path === archive.path)).toHaveLength(1);

  // The program's own output is the engine log, and the token is not in it.
  await eventually(async () => h.localEngine.logs.lines().some((line) => line.includes("fake native engine 2.6.0 started")));
  expect(h.localEngine.logs.lines().join("\n")).not.toContain(h.engineStore.local()?.token as string);
});

test("an archive that is not the one the manifest pins is refused and nothing is unpacked", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const h = start(recordingSpawn());
  await publish(archive, 2);
  const altered = new Uint8Array(archive.bytes);
  altered[altered.length - 1] = (altered[altered.length - 1] as number) ^ 0xff;
  fake.files.set(archive.path, altered);
  await send(h, "POST", "/api/packages/refresh");

  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).problem?.code === "download.checksum_mismatch");
  expect(existsSync(join(h.dataFolder, "engine-packages"))).toBe(false);
  expect(h.settings.get("local.package")).toBeNull();
});

test("a package without its program, or an archive that is not one, is refused with a code", async () => {
  const missing = await buildNativeArchive({ version: "2.6.0", omitExecutable: true });
  const h = start(recordingSpawn());
  await offer(h, missing, 2);
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).problem?.code === "install.unpack_failed");
  expect((await localView(h)).problem?.data).toEqual({ reason: "executable_missing" });
  expect(readdirSync(join(h.dataFolder, "engine-packages"))).toEqual([]);
  await harness?.stop();

  const garbage = new TextEncoder().encode("this is not a tar file at all");
  const notTar: TestArchive = { ...missing, version: "2.7.0", bytes: garbage, path: "/releases/download/v2.7.0/not.tar.gz", sha256: new Bun.CryptoHasher("sha256").update(garbage).digest("hex") };
  const g = start(recordingSpawn());
  await offer(g, notTar, 3);
  expect((await send(g, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(g)).problem?.code === "install.unpack_failed");
  expect((await localView(g)).problem?.data).toMatchObject({ reason: "tar" });
  expect(readdirSync(join(g.dataFolder, "engine-packages"))).toEqual([]);
});

test("an install with too little free disk is refused before anything is downloaded", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const h = start(recordingSpawn(), { harness: { freeBytes: () => 10 } });
  await offer(h, archive, 2);
  const refused = await send(h, "POST", "/api/local-engine/install");
  expect(refused.status).toBe(409);
  expect((await errorOf(refused)).code).toBe("install.not_enough_space");
  expect(fake.requests.filter((request) => request.path === archive.path)).toEqual([]);
});

// Criterion: the recorded spawn has the working directory set to the engine data directory and carries the port, token, one parallel job and the engine path.

test("the program is started in the engine data folder with the port, the token, one parallel job and the engine path", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const h = start(spawner);
  await offer(h, archive, 2);
  await installAndWaitReady(h);

  const engine = h.engineStore.local();
  const port = new URL(engine?.address as string).port;
  const folder = join(h.dataFolder, "engine-packages", "2.6.0");
  expect(spawner.starts).toHaveLength(1);
  expect(spawner.starts[0]?.cwd).toBe(join(h.dataFolder, "engine-data"));
  expect(spawner.starts[0]?.argv).toEqual([
    join(folder, "aidm-api"),
    "--port",
    port,
    "--token",
    engine?.token as string,
    "--parallel_queue_processing",
    "1",
    "--odx_path",
    join(folder, "engine"),
  ]);
  expect(h.settings.get("local.native")).toEqual({ pid: spawner.starts[0]?.pid as number, port: Number(port), version: "2.6.0" });
  // The program saw the same folder as its working directory.
  await eventually(async () => h.localEngine.logs.lines().some((line) => line.includes(`started in ${join(h.dataFolder, "engine-data")} `)));
});

// Criterion: after an aidm-ui restart, the running fake process is found by pid, confirmed by token, and not started twice.

test("after aidm-ui restarts, the running program is found by its pid, confirmed by the token and not started twice", async () => {
  const folder = keptFolder();
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const first = start(spawner, { harness: { dataFolder: folder } });
  await offer(first, archive, 2);
  await installAndWaitReady(first);
  const record = first.settings.get("local.native");
  const token = first.engineStore.local()?.token;
  await first.stop({ leaveEngines: true });
  expect(alive(record?.pid as number)).toBe(true);

  const second = start(spawner, { harness: { dataFolder: folder } });
  await eventually(async () => (await localView(second)).state === "ready");
  expect(spawner.starts).toHaveLength(1);
  expect(second.settings.get("local.native")).toEqual(record);
  expect(second.engineStore.local()?.token).toBe(token);
  expect(await runningVersion(second)).toBe("2.6.0");
  // The output of the program that kept running is followed again, from where it is now.
  await eventually(async () => second.localEngine.logs.isFollowing());
});

test("a program that answers with another token is not taken for the engine, and is left alone", async () => {
  const folder = keptFolder();
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const first = start(spawner, { harness: { dataFolder: folder } });
  await offer(first, archive, 2);
  await installAndWaitReady(first);
  const original = first.settings.get("local.native");
  strays.push(original?.pid as number);
  // The number now belongs to another program, which answers on the recorded port with a token of its own.
  const stranger = new FakeTaskApi({ token: "someone-elses" });
  await stranger.start();
  first.settings.set("local.native", { ...(original as NonNullable<typeof original>), port: Number(new URL(stranger.address).port) });
  await first.stop({ leaveEngines: true });

  const second = start(spawner, { harness: { dataFolder: folder } });
  await eventually(async () => spawner.starts.length === 2);
  await eventually(async () => (await localView(second)).state === "ready");
  expect(alive(original?.pid as number)).toBe(true);
  expect(second.settings.get("local.native")?.pid).toBe(spawner.starts[1]?.pid as number);
  await stranger.stop();
});

// Criterion: on Linux with systemd present (recorded), the spawn is wrapped in a user scope with the memory limit; without systemd, the warning is shown.

test("with systemd the program is started inside a user scope with the memory limit", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const h = start(spawner, { harness: { runner: runnerWithSystemd(true) } });
  await offer(h, archive, 2);
  await installAndWaitReady(h);

  const memory = (await localView(h)).caps.memoryBytes;
  const folder = join(h.dataFolder, "engine-packages", "2.6.0");
  expect(spawner.starts[0]?.argv.slice(0, 8)).toEqual([
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "-p",
    `MemoryMax=${memory}`,
    "--",
    join(folder, "aidm-api"),
  ]);
  expect(spawner.starts[0]?.argv).toContain("--odx_path");
  expect(spawner.starts[0]?.cwd).toBe(join(h.dataFolder, "engine-data"));
  const view = await localView(h);
  expect(view.warnings).toEqual([]);
  expect(view.caps.applied).toEqual({ memoryBytes: memory, cpus: null });
});

test("without systemd the program is not wrapped and the view warns that the memory limit has no effect", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const h = start(spawner, { harness: { runner: runnerWithSystemd(false) } });
  await offer(h, archive, 2);
  await installAndWaitReady(h);

  expect(spawner.starts[0]?.argv[0]).toBe(join(h.dataFolder, "engine-packages", "2.6.0", "aidm-api"));
  const view = await localView(h);
  expect(view.warnings).toEqual([{ code: "local.memory_cap_not_enforced", data: {} }]);
  expect(view.caps.applied).toEqual({ memoryBytes: null, cpus: null });
});

test("on a Mac the native package runs without a memory limit, and systemd is not asked for", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const asked: string[][] = [];
  const base = runnerWithSystemd(true);
  const h = start(spawner, {
    harness: {
      localMachine: { platform: "darwin", arch: "arm64", totalMemory: 32 * GiB, cpuCount: 8 },
      runner: {
        run: (argv, options) => (asked.push(argv), base.run(argv, options)),
        stream: (argv, options) => base.stream(argv, options),
      },
    },
  });
  await offer(h, archive, 2, "darwin-arm64");
  await installAndWaitReady(h);
  expect(asked.filter((argv) => argv[0] === "systemctl")).toEqual([]);
  expect(spawner.starts[0]?.argv[0]).toBe(join(h.dataFolder, "engine-packages", "2.6.0", "aidm-api"));
  expect((await localView(h)).warnings).toEqual([{ code: "local.memory_cap_not_enforced", data: {} }]);
}, { timeout: 15000 });

test("lowering the CPU cores shows that a program cannot be held to them", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const h = start(recordingSpawn(), { harness: { runner: runnerWithSystemd(true) } });
  await offer(h, archive, 2);
  await installAndWaitReady(h);
  expect((await localView(h)).warnings).toEqual([]);
  const caps = (await localView(h)).caps;
  const saved = await fetch(`${h.base}/api/local-engine/caps`, { method: "PUT", body: JSON.stringify({ memoryBytes: caps.memoryBytes, cpus: 2 }) });
  expect(saved.status).toBe(200);
  expect((await localView(h)).warnings).toEqual([{ code: "local.cpu_cap_not_enforced", data: {} }]);
});

// The switch and the crash path work as for a container.

test("switching the engine off ends the program, and switching it on starts a new one in the same folder", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const h = start(spawner);
  await offer(h, archive, 2);
  await installAndWaitReady(h);
  const pid = spawner.starts[0]?.pid as number;

  await fetch(`${h.base}/api/local-engine/enabled`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  expect(alive(pid)).toBe(false);
  expect(h.settings.get("local.native")).toBeNull();

  await fetch(`${h.base}/api/local-engine/enabled`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
  await eventually(async () => (await localView(h)).state === "ready");
  expect(spawner.starts).toHaveLength(2);
  expect(spawner.starts[1]?.cwd).toBe(spawner.starts[0]?.cwd as string);
});

test("a program that dies is started again by the manager", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const h = start(spawner, { harness: { startingGraceMs: 0 } });
  await offer(h, archive, 2);
  await installAndWaitReady(h);

  process.kill(-(spawner.starts[0]?.pid as number), "SIGKILL");
  await eventually(async () => spawner.starts.length === 2);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(h.logs.some((line) => line.includes("Starting it again"))).toBe(true);
});

// Criterion: update, rollback and cleanup work for the native kind.

test("an update unpacks the new version next to the old and switches after the new one answers", async () => {
  const spawner = recordingSpawn();
  const h = start(spawner);
  await offer(h, await buildNativeArchive({ version: "2.6.0" }), 2);
  await installAndWaitReady(h);
  const token = h.engineStore.local()?.token;
  const oldPid = spawner.starts[0]?.pid as number;
  await offer(h, await buildNativeArchive({ version: "2.7.0" }), 3);
  await eventually(async () => (await localView(h)).update.available?.packageVersion === "2.7.0");

  const seen: LocalEngineView[] = [];
  h.localEngine.subscribe((view) => seen.push(view));
  await updateTo(h, "2.7.0");

  const view = await localView(h);
  expect(view.update).toEqual({ available: null, previous: { packageVersion: "2.6.0" }, blockedBy: null, applying: null });
  expect(view.installed?.packageVersion).toBe("2.7.0");
  expect(view.problem).toBeNull();
  expect(h.engineStore.local()?.installedVersion).toBe("2.7.0");
  expect(h.engineStore.local()?.token).toBe(token);
  expect(h.settings.get("local.switch")).toBeNull();
  expect(packageFolders(h)).toEqual(["2.6.0", "2.7.0"]);
  // The old program is gone, the new one runs from the new folder in the same data folder.
  expect(alive(oldPid)).toBe(false);
  expect(spawner.starts).toHaveLength(2);
  expect(spawner.starts[1]?.argv[0]).toBe(join(h.dataFolder, "engine-packages", "2.7.0", "aidm-api"));
  expect(spawner.starts[1]?.cwd).toBe(spawner.starts[0]?.cwd as string);
  const phases = seen.map((v) => v.update.applying?.phase).filter((phase) => phase !== undefined);
  expect(phases[0]).toBe("pulling");
  expect(phases).toContain("starting");
  // The log follows the new program.
  await eventually(async () => h.localEngine.logs.lines().some((line) => line.includes("fake native engine 2.7.0 started")));
});

test("after two updates only the current and the previous folder remain", async () => {
  const spawner = recordingSpawn();
  const h = start(spawner);
  await offer(h, await buildNativeArchive({ version: "2.6.0" }), 2);
  await installAndWaitReady(h);
  await offer(h, await buildNativeArchive({ version: "2.7.0" }), 3);
  await eventually(async () => (await localView(h)).update.available?.packageVersion === "2.7.0");
  await updateTo(h, "2.7.0");
  expect(packageFolders(h)).toEqual(["2.6.0", "2.7.0"]);

  await offer(h, await buildNativeArchive({ version: "2.8.0" }), 4);
  await eventually(async () => (await localView(h)).update.available?.packageVersion === "2.8.0");
  await updateTo(h, "2.8.0");

  expect(packageFolders(h)).toEqual(["2.7.0", "2.8.0"]);
  const view = await localView(h);
  expect(view.update.previous).toEqual({ packageVersion: "2.7.0" });
  expect(h.settings.get("local.previous")?.packageVersion).toBe("2.7.0");
});

test("a new version that never becomes ready is rolled back by itself, and its folder and program are gone", async () => {
  const spawner = recordingSpawn();
  const h = start(spawner, { timeoutMs: 600 });
  await offer(h, await buildNativeArchive({ version: "2.6.0" }), 2);
  await installAndWaitReady(h);
  await offer(h, await buildNativeArchive({ version: "2.7.0", silent: true }), 3);
  await eventually(async () => (await localView(h)).update.available?.packageVersion === "2.7.0");

  expect((await send(h, "POST", "/api/local-engine/update")).status).toBe(202);
  await eventually(async () => (await localView(h)).problem?.code === "update.failed_rolled_back");
  await eventually(async () => (await runningVersion(h)) === "2.6.0");

  const view = await localView(h);
  expect(view.problem).toEqual({ code: "update.failed_rolled_back", data: { version: "2.7.0" } });
  expect(view.installed?.packageVersion).toBe("2.6.0");
  expect(view.update.previous).toBeNull();
  expect(view.update.applying).toBeNull();
  expect(h.settings.get("local.switch")).toBeNull();
  expect(h.engineStore.local()?.installedVersion).toBe("2.6.0");
  expect(packageFolders(h)).toEqual(["2.6.0"]);
  expect(spawner.starts).toHaveLength(3);
  expect(alive(spawner.starts[1]?.pid as number)).toBe(false);
  expect(spawner.starts[2]?.argv[0]).toBe(join(h.dataFolder, "engine-packages", "2.6.0", "aidm-api"));
});

test("a manual rollback starts the previous version while its folder exists, and keeps the other as the previous", async () => {
  const spawner = recordingSpawn();
  const h = start(spawner);
  await offer(h, await buildNativeArchive({ version: "2.6.0" }), 2);
  await installAndWaitReady(h);
  await offer(h, await buildNativeArchive({ version: "2.7.0" }), 3);
  await eventually(async () => (await localView(h)).update.available?.packageVersion === "2.7.0");
  await updateTo(h, "2.7.0");

  expect((await send(h, "POST", "/api/local-engine/rollback")).status).toBe(202);
  await untilCurrent(h, "2.6.0");

  const view = await localView(h);
  expect(view.update.previous).toEqual({ packageVersion: "2.7.0" });
  expect(view.problem).toBeNull();
  expect(h.engineStore.local()?.installedVersion).toBe("2.6.0");
  expect(packageFolders(h)).toEqual(["2.6.0", "2.7.0"]);

  // Forward again reuses the folder that is still there.
  const downloads = fake.requests.filter((request) => request.path.endsWith(".tar.gz")).length;
  await updateTo(h, "2.7.0");
  expect(fake.requests.filter((request) => request.path.endsWith(".tar.gz")).length).toBe(downloads);
  expect(packageFolders(h)).toEqual(["2.6.0", "2.7.0"]);
});

test("a rollback is refused when there is no previous version, and fails safely when its folder is gone", async () => {
  const spawner = recordingSpawn();
  const h = start(spawner, { timeoutMs: 600 });
  await offer(h, await buildNativeArchive({ version: "2.6.0" }), 2);
  await installAndWaitReady(h);
  expect(await errorOf(await send(h, "POST", "/api/local-engine/rollback"))).toEqual({ code: "update.no_previous", data: {} });

  await offer(h, await buildNativeArchive({ version: "2.7.0" }), 3);
  await eventually(async () => (await localView(h)).update.available?.packageVersion === "2.7.0");
  await updateTo(h, "2.7.0");
  rmSync(join(h.dataFolder, "engine-packages", "2.6.0"), { recursive: true });

  expect((await send(h, "POST", "/api/local-engine/rollback")).status).toBe(202);
  await eventually(async () => (await localView(h)).problem?.code === "update.rollback_failed");
  await eventually(async () => (await runningVersion(h)) === "2.7.0");
  const view = await localView(h);
  expect(view.installed?.packageVersion).toBe("2.7.0");
  expect(view.update.previous).toEqual({ packageVersion: "2.6.0" });
});

test("aidm-ui stopping while the new program never answers puts the previous version back at the next start", async () => {
  const folder = keptFolder();
  const spawner = recordingSpawn();
  const first = start(spawner, { timeoutMs: 5000, harness: { dataFolder: folder } });
  await offer(first, await buildNativeArchive({ version: "2.6.0" }), 2);
  await installAndWaitReady(first);
  await offer(first, await buildNativeArchive({ version: "2.7.0", silent: true }), 3);
  await eventually(async () => (await localView(first)).update.available?.packageVersion === "2.7.0");
  expect((await send(first, "POST", "/api/local-engine/update")).status).toBe(202);
  await eventually(async () => spawner.starts.length === 2);
  const silentPid = spawner.starts[1]?.pid as number;
  await first.stop({ leaveEngines: true });
  expect(alive(silentPid)).toBe(true);

  const second = start(spawner, { timeoutMs: 600, harness: { dataFolder: folder } });
  await eventually(async () => (await localView(second)).problem?.code === "update.failed_rolled_back");
  await eventually(async () => (await runningVersion(second)) === "2.6.0");
  expect((await localView(second)).installed?.packageVersion).toBe("2.6.0");
  expect(second.settings.get("local.switch")).toBeNull();
  // The program that never answered is found by its token on the command line and ended.
  expect(alive(silentPid)).toBe(false);
  expect(packageFolders(second)).toEqual(["2.6.0"]);
});
