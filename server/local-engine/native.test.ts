import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { LocalEngineView, VariantId } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import {
  archiveFetch,
  buildHostileArchive,
  buildNativeArchive,
  nativeRelease,
  runnerWithSystemd,
  type Hostility,
  type TestArchive,
} from "../../test-support/native-archive.ts";
import { generateSigner, signedRelease, type TestSigner } from "../../test-support/signed-manifest.ts";
import { ACCEPTED_KEYS } from "../manifest/keys.ts";
import type { Manifest } from "../manifest/schema.ts";
import { engineConfigFile, spawnEngine, type NativeOptions, type SpawnEngine } from "../packages/native-package.ts";
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

/**
 * What a start was asked to run, and where. The program is really started,
 * except for the wrapper of a memory limit, which is never run for real: the
 * program behind it is started directly, or, with `wrapperFails`, the wrapper
 * ends at once with an error, as systemd-run does when it is refused.
 */
function recordingSpawn(options: { wrapperFails?: boolean } = {}) {
  const starts: Array<{ argv: string[]; cwd: string; pid: number }> = [];
  const spawn: SpawnEngine = (argv, spawnOptions) => {
    const wrapped = argv[0] === "systemd-run";
    const direct = wrapped ? argv.slice(argv.indexOf("--") + 1) : argv;
    const refused = ["sh", "-c", "echo 'Failed to start transient scope unit: Access denied' >&2; exit 1"];
    const child = spawnEngine(wrapped && options.wrapperFails === true ? refused : direct, spawnOptions);
    const { cwd } = spawnOptions;
    starts.push({ argv, cwd, pid: child.pid });
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
  options: { timeoutMs?: number; harness?: Parameters<typeof openHarness>[0]; native?: NativeOptions } = {},
): Harness {
  harness = openHarness({
    enginePollMs: 50,
    runPollMs: 30,
    // No container tool at all: a native package needs none.
    runtimes: {},
    updateReadyTimeoutMs: options.timeoutMs ?? 3000,
    manifest: { releasesUrl: fake.url("/releases"), keys: [signer.key, ...ACCEPTED_KEYS], fetch: (url, init) => fetch(url, init) },
    native: { spawn: spawner.spawn, fetch: archiveFetch((path) => fake.url(path)), ...options.native },
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
  expect((await localView(h)).installed).toBeNull();
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

// Criterion: the recorded spawn has the working directory set to the engine data directory and carries the config file of the port, token, one parallel job and engine path.

test("the program is started in the engine data folder with only the path of its config file, and the token is not on any command line", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const h = start(spawner);
  await offer(h, archive, 2);
  await installAndWaitReady(h);

  const engine = h.engineStore.local();
  const token = engine?.token as string;
  const port = new URL(engine?.address as string).port;
  const folder = join(h.dataFolder, "engine-packages", "2.6.0");
  const config = join(h.dataFolder, "engine-config", "native-2.6.0.json");
  expect(spawner.starts).toHaveLength(1);
  expect(spawner.starts[0]?.cwd).toBe(join(h.dataFolder, "engine-data"));
  expect(spawner.starts[0]?.argv).toEqual([join(folder, "aidm-api"), "--config", config]);
  expect(spawner.starts[0]?.argv.join(" ")).not.toContain(token);
  // What the system shows to every user of the computer holds no token either.
  if (process.platform === "linux") {
    const shown = readFileSync(`/proc/${spawner.starts[0]?.pid}/cmdline`, "utf8");
    expect(shown).toContain(config);
    expect(shown).not.toContain(token);
  }
  // The file is the one way the token reaches the program, and only this user may read it.
  expect(statSync(config).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
    token,
    port: Number(port),
    parallelQueueProcessing: 1,
    odx_path: join(folder, "engine"),
  });
  // The program read it: it answers on that port, to that token, in that folder.
  expect(await runningVersion(h)).toBe("2.6.0");
  await eventually(async () => h.localEngine.logs.lines().some((line) => line.includes(`started in ${join(h.dataFolder, "engine-data")} `)));
});

// Criterion: after an aidm-ui restart, the running fake process is found by pid, confirmed by token, and not started twice.

test("after aidm-ui restarts, the running program is found by its pid, confirmed by its command line and its token, and not started twice", async () => {
  const folder = keptFolder();
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const first = start(spawner, { harness: { dataFolder: folder } });
  await offer(first, archive, 2);
  await installAndWaitReady(first);
  const pid = spawner.starts[0]?.pid as number;
  const token = first.engineStore.local()?.token;
  await first.stop({ leaveEngines: true });
  expect(alive(pid)).toBe(true);

  const second = start(spawner, { harness: { dataFolder: folder } });
  await eventually(async () => (await localView(second)).state === "ready");
  expect(spawner.starts).toHaveLength(1);
  expect(alive(pid)).toBe(true);
  expect(second.engineStore.local()?.token).toBe(token);
  expect(await runningVersion(second)).toBe("2.6.0");
  // The output of the program that kept running is followed again, from where it is now.
  await eventually(async () => second.localEngine.logs.isFollowing());
});

test("after aidm-ui restarts, a running program that refuses the stored token is stopped and started again", async () => {
  const folder = keptFolder();
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const first = start(spawner, { harness: { dataFolder: folder } });
  await offer(first, archive, 2);
  await installAndWaitReady(first);
  const pid = spawner.starts[0]?.pid as number;
  const engine = first.engineStore.local();
  // The stored token no longer matches the one the running program has, as after a restored backup.
  first.engineStore.update(engine?.id as number, { token: "a-token-the-program-never-had" });
  await first.stop({ leaveEngines: true });

  const second = start(spawner, { harness: { dataFolder: folder } });
  await eventually(async () => spawner.starts.length === 2 && (await localView(second)).state === "ready");
  expect(alive(pid)).toBe(false);
});

/** A process that is not the engine, such as the program that now has a number the engine used to have. */
function bystander(): { pid: number; alive: () => boolean } {
  const child = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  child.unref();
  strays.push(child.pid);
  return { pid: child.pid, alive: () => alive(child.pid) };
}

test("a program that is not the engine, on the recorded pid and port, is left alone and is never sent the token", async () => {
  const folder = keptFolder();
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const first = start(spawner, { harness: { dataFolder: folder } });
  await offer(first, archive, 2);
  await installAndWaitReady(first);
  const original = first.settings.get("local.native");
  strays.push(original?.pid as number);
  // The number now belongs to another program, which answers on the recorded port like a task API of its own.
  const stranger = bystander();
  const listener = new FakeTaskApi({ token: "someone-elses" });
  await listener.start();
  first.settings.set("local.native", {
    pid: stranger.pid,
    port: Number(new URL(listener.address).port),
    version: "2.6.0",
  });
  await first.stop({ leaveEngines: true });

  const second = start(spawner, { harness: { dataFolder: folder } });
  await eventually(async () => spawner.starts.length === 2);
  await eventually(async () => (await localView(second)).state === "ready");
  expect(stranger.alive()).toBe(true);
  expect(listener.requests.filter((request) => request.token !== null)).toEqual([]);
  expect(listener.requests).toEqual([]);
  await listener.stop();
});

test("a program that is the engine but does not confirm it is still the engine: it is kept, not started twice, and ended when asked", async () => {
  const folder = keptFolder();
  // The info route answers without a version, like an engine that is not well. It is never ready, but it runs.
  const archive = await buildNativeArchive({ version: "2.6.0", badInfo: true });
  const spawner = recordingSpawn();
  const first = start(spawner, { harness: { dataFolder: folder } });
  await offer(first, archive, 2);
  expect((await send(first, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => spawner.starts.length === 1);
  const pid = spawner.starts[0]?.pid as number;
  strays.push(pid);
  await first.stop({ leaveEngines: true });

  const second = start(spawner, { harness: { dataFolder: folder } });
  await eventually(async () => second.localEngine.logs.isFollowing());
  expect(spawner.starts).toHaveLength(1);
  expect(alive(pid)).toBe(true);

  const off = await fetch(`${second.base}/api/local-engine/enabled`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  expect(off.status).toBe(200);
  expect(alive(pid)).toBe(false);
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
  // The scope shows the command line of the program, and so no token.
  expect(spawner.starts[0]?.argv.slice(8)).toEqual(["--config", engineConfigFile(h.dataFolder, "2.6.0")]);
  expect(spawner.starts[0]?.argv.join(" ")).not.toContain(h.engineStore.local()?.token as string);
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

test("a systemd that cannot start a scope is found out once, and the program is started without a limit and with the warning", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn();
  const calls: Array<{ argv: string[]; timeoutMs: number | undefined }> = [];
  const h = start(spawner, { harness: { runner: runnerWithSystemd(true, { scope: false, calls }) } });
  await offer(h, archive, 2);
  await installAndWaitReady(h);

  expect(spawner.starts[0]?.argv[0]).toBe(join(h.dataFolder, "engine-packages", "2.6.0", "aidm-api"));
  const view = await localView(h);
  expect(view.warnings).toEqual([{ code: "local.memory_cap_not_enforced", data: {} }]);
  expect(view.caps.applied).toEqual({ memoryBytes: null, cpus: null });
  // Both questions to systemd are bounded, and the trial scope is the one with the limit that a start would use.
  expect(calls).toEqual([
    { argv: ["systemctl", "--user", "show-environment"], timeoutMs: 10_000 },
    { argv: ["systemd-run", "--user", "--scope", "--quiet", "-p", "MemoryMax=1G", "--", "true"], timeoutMs: 10_000 },
  ]);

  // A second start does not try again.
  await fetch(`${h.base}/api/local-engine/enabled`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  await fetch(`${h.base}/api/local-engine/enabled`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
  await eventually(async () => (await localView(h)).state === "ready");
  expect(calls).toHaveLength(2);
});

test("a start inside a scope that ends at once is tried again without the scope, and the view warns", async () => {
  const archive = await buildNativeArchive({ version: "2.6.0" });
  const spawner = recordingSpawn({ wrapperFails: true });
  const h = start(spawner, { harness: { runner: runnerWithSystemd(true) } });
  await offer(h, archive, 2);
  await installAndWaitReady(h);

  const program = join(h.dataFolder, "engine-packages", "2.6.0", "aidm-api");
  expect(spawner.starts.map((entry) => entry.argv[0])).toEqual(["systemd-run", program]);
  const view = await localView(h);
  expect(view.warnings).toEqual([{ code: "local.memory_cap_not_enforced", data: {} }]);
  expect(view.caps.applied).toEqual({ memoryBytes: null, cpus: null });
  expect(await runningVersion(h)).toBe("2.6.0");
  expect(h.logs.some((line) => line.includes("Access denied"))).toBe(true);

  // The next start goes straight to the program.
  await fetch(`${h.base}/api/local-engine/enabled`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  await fetch(`${h.base}/api/local-engine/enabled`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
  await eventually(async () => (await localView(h)).state === "ready");
  expect(spawner.starts.map((entry) => entry.argv[0])).toEqual(["systemd-run", program, program]);
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
  expect((await localView(h)).enabled).toBe(false);

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

// A program that ignores the polite stop is ended by force.

test("a program that ignores the polite stop is ended by force when the engine is switched off", async () => {
  const spawner = recordingSpawn();
  const h = start(spawner, { native: { stopGraceMs: 300 } });
  await offer(h, await buildNativeArchive({ version: "2.6.0", ignoreTerm: true }), 2);
  await installAndWaitReady(h);
  const pid = spawner.starts[0]?.pid as number;

  const off = await fetch(`${h.base}/api/local-engine/enabled`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  expect(off.status).toBe(200);
  expect(alive(pid)).toBe(false);
  expect(h.logs.some((line) => line.includes("ended by force"))).toBe(true);
});

// The engine's output file is bounded.

test("the output of a noisy engine is kept in a file that is copied and emptied, with three old copies at most", async () => {
  const spawner = recordingSpawn();
  const limit = 64 * 1024;
  const h = start(spawner, { native: { outputRotateBytes: limit } });
  await offer(h, await buildNativeArchive({ version: "2.6.0", noiseLines: 4000 }), 2);
  await installAndWaitReady(h);
  // 4000 lines of about 100 bytes, six times the limit.
  await eventually(async () => h.localEngine.logs.lines().some((line) => line.includes("noise done")), 10_000);

  const files = readdirSync(join(h.dataFolder, "logs"))
    .filter((name) => name.startsWith("native-engine.out"))
    .sort();
  expect(files).toEqual(["native-engine.out", "native-engine.out.1", "native-engine.out.2", "native-engine.out.3"]);
  for (const name of files) {
    // A little over the limit: the engine writes on between two looks at the file.
    expect(statSync(join(h.dataFolder, "logs", name)).size).toBeLessThan(2 * limit);
  }
}, { timeout: 20000 });

// An archive is not trusted.

async function refusedWith(archive: TestArchive, reason: string): Promise<Harness> {
  const h = start(recordingSpawn());
  await offer(h, archive, 2);
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).problem?.code === "install.unpack_failed");
  expect((await localView(h)).problem?.data).toMatchObject({ reason });
  expect(readdirSync(join(h.dataFolder, "engine-packages"))).toEqual([]);
  expect((await localView(h)).installed).toBeNull();
  return h;
}

test("an archive with an absolute path is refused and writes nothing there", async () => {
  const outside = join(keptFolder(), "elsewhere");
  const hostile: Hostility = { kind: "absolute_path", target: outside };
  await refusedWith(await buildHostileArchive("2.6.0", hostile), "unsafe_path");
  expect(existsSync(outside)).toBe(false);
});

test("an archive with an entry that climbs out of the folder is refused", async () => {
  const h = await refusedWith(await buildHostileArchive("2.6.0", { kind: "parent_path" }), "unsafe_path");
  expect(existsSync(join(h.dataFolder, "aidm-api-2.6.0-linux-x64"))).toBe(false);
  expect(existsSync(join(h.dataFolder, "engine-packages", "aidm-api-2.6.0-linux-x64"))).toBe(false);
});

test("an archive with a link to a place outside its folder is refused, whether the link is absolute or climbs out", async () => {
  const outside = keptFolder();
  mkdirSync(join(outside, "secrets"));
  await refusedWith(await buildHostileArchive("2.6.0", { kind: "link_outside", target: join(outside, "secrets") }), "unsafe_link");
  await harness?.stop();
  harness = undefined;
  await refusedWith(await buildHostileArchive("2.6.0", { kind: "link_outside", target: "../../../../../../../../etc" }), "unsafe_link");
});

test("an archive whose program is a link is refused, even to a file inside the package", async () => {
  await refusedWith(await buildHostileArchive("2.6.0", { kind: "program_is_link" }), "executable_not_a_file");
});

test("an archive that unpacks to far more than its own size is refused before anything is unpacked", async () => {
  const archive = await buildHostileArchive("2.6.0", { kind: "size_bomb", bytes: 32 * 1024 * 1024 });
  expect(archive.bytes.length).toBeLessThan(1024 * 1024);
  await refusedWith(archive, "too_large");
});
