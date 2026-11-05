import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, win32 } from "node:path";
import { fakeProgramScript } from "../../test-support/native-archive.ts";
import { recordedText } from "../../test-support/scripted-runner.ts";
import { windowsRunner } from "../../test-support/windows-command-line.ts";
import { systemRunner } from "../process/command-runner.ts";
import type { NativeProcess, Settings } from "../settings/settings.ts";
import {
  engineConfigFile,
  engineSpawner,
  NativePackage,
  spawnEngine,
  usesConfig,
  windowsCommandLineQuery,
  type ChildState,
  type NativePackageDeps,
  type SpawnEngine,
  type SpawnProcess,
} from "./native-package.ts";

const GiB = 1024 ** 3;

let dataFolder: string;
const pids: number[] = [];
let record: NativeProcess | null;

beforeEach(() => {
  // A space in the path, as in a Windows user name with a space.
  dataFolder = mkdtempSync(join(os.tmpdir(), "aidm-ui native-package-"));
  record = null;
  // A package that is already unpacked: its program starts the fake engine.
  const folder = join(dataFolder, "engine-packages", "2.6.0");
  mkdirSync(join(folder, "engine"), { recursive: true });
  writeFileSync(join(folder, "aidm-api"), fakeProgramScript({ reports: "2.6.0" }));
  chmodSync(join(folder, "aidm-api"), 0o755);
});

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  rmSync(dataFolder, { recursive: true, force: true });
});

function memorySettings(): Pick<Settings, "get" | "set"> {
  return {
    get: ((key: string) => (key === "local.native" ? record : null)) as unknown as Settings["get"],
    set: ((key: string, value: NativeProcess | null) => {
      if (key === "local.native") record = value;
    }) as unknown as Settings["set"],
  };
}

function packageWith(overrides: Partial<NativePackageDeps> = {}) {
  const starts: number[] = [];
  const spawned: Array<{ argv: string[]; windowsHide: boolean }> = [];
  const spawn: SpawnEngine = (argv, options) => {
    const child = spawnEngine(argv, options);
    starts.push(child.pid);
    spawned.push({ argv, windowsHide: options.windowsHide });
    pids.push(child.pid);
    return child;
  };
  const children = new Map<number, ChildState>();
  const pkg = new NativePackage({
    variant: { kind: "native", url: "https://example.test/a.tar.gz", size: 1000, sha256: "ab".repeat(32), gpu: false },
    variantId: "linux-amd64-cpu",
    version: "2.6.0",
    dataFolder,
    freeBytes: () => 100 * GiB,
    settings: memorySettings(),
    runner: systemRunner(),
    systemd: () => false,
    children,
    log: () => {},
    spawn,
    stopGraceMs: 150,
    ...overrides,
  });
  return { pkg, starts, spawned, children };
}

const startOptions = {
  hostPort: 0,
  token: "a-secret-token",
  memoryBytes: null,
  cpus: null,
  // Inside the data folder of the test, which goes after each test with what the start makes in it.
  get engineDataFolder() {
    return join(dataFolder, "engine-data");
  },
  gpu: false,
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a program that cannot be ended stays on record, and no second program is started next to it", async () => {
  // Nothing reaches the program: neither the polite stop nor the force.
  const { pkg, starts } = packageWith({ sendSignal: () => {} });
  expect((await pkg.start(startOptions)).ok).toBe(true);
  expect(starts).toHaveLength(1);

  const stopped = await pkg.stop();
  expect(stopped).toEqual({ ok: false, error: { code: "runtime.command_failed", data: { operation: "stop", reason: "still_running" } } });
  expect(await pkg.status()).toEqual({ ok: true, value: { state: "running", exitCode: null } });

  const again = await pkg.start(startOptions);
  expect(again).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { reason: "previous_engine_running" } } });
  expect(starts).toHaveLength(1);
  expect(alive(starts[0] as number)).toBe(true);
});

test("a program that is ours is ended, and the next start runs a new one", async () => {
  const { pkg, starts } = packageWith();
  expect((await pkg.start(startOptions)).ok).toBe(true);
  expect((await pkg.start(startOptions)).ok).toBe(true);
  expect(starts).toHaveLength(2);
  expect(alive(starts[0] as number)).toBe(false);
  expect(alive(starts[1] as number)).toBe(true);
  expect((await pkg.stop()).ok).toBe(true);
  expect(alive(starts[1] as number)).toBe(false);
  expect(await pkg.status()).toEqual({ ok: true, value: { state: "missing", exitCode: null } });
});

test("before each start the folders the task API reads where it runs are there, and tests/data in test mode", async () => {
  const { pkg } = packageWith();
  expect((await pkg.start(startOptions)).ok).toBe(true);
  expect(existsSync(join(dataFolder, "engine-data", "data"))).toBe(true);
  expect(existsSync(join(dataFolder, "engine-data", "tmp"))).toBe(true);
  expect(existsSync(join(dataFolder, "engine-data", "tests"))).toBe(false);
  await pkg.stop();
  const testMode = packageWith({ extraArgs: ["--test"] });
  expect((await testMode.pkg.start(startOptions)).ok).toBe(true);
  expect(existsSync(join(dataFolder, "engine-data", "tests", "data"))).toBe(true);
});

test("the command line of the program names its config file and holds no token", async () => {
  if (process.platform !== "linux") return;
  const { pkg, starts } = packageWith();
  expect((await pkg.start(startOptions)).ok).toBe(true);
  // Right after the spawn the new process may not have its command line yet.
  let shown: string[] = [];
  for (let tries = 0; tries < 100 && !shown.join(" ").includes("--config"); tries++) {
    shown = readFileSync(`/proc/${starts[0]}/cmdline`, "utf8").split("\0");
    if (!shown.join(" ").includes("--config")) await Bun.sleep(20);
  }
  expect(shown.join(" ")).toContain(`--config ${join(dataFolder, "engine-config", "native-2.6.0.json")}`);
  expect(shown.join(" ")).not.toContain(startOptions.token);
});

test("a log read with no tail starts at the last 500 lines", async () => {
  const { pkg } = packageWith();
  mkdirSync(join(dataFolder, "logs"), { recursive: true });
  const lines = Array.from({ length: 3000 }, (_, n) => `line ${n + 1}`);
  writeFileSync(join(dataFolder, "logs", "native-engine.out"), `${lines.join("\n")}\n`);

  const seen: string[] = [];
  expect((await pkg.logs({ follow: false, onLine: (line) => seen.push(line) })).ok).toBe(true);
  expect(seen).toHaveLength(500);
  expect(seen[0]).toBe("line 2501");
  expect(seen.at(-1)).toBe("line 3000");

  const few: string[] = [];
  await pkg.logs({ follow: false, tail: 3, onLine: (line) => few.push(line) });
  expect(few).toEqual(["line 2998", "line 2999", "line 3000"]);
});

test("a log read does not cut a line the program is still writing, and hands it over when it ends", async () => {
  const { pkg } = packageWith();
  mkdirSync(join(dataFolder, "logs"), { recursive: true });
  writeFileSync(join(dataFolder, "logs", "native-engine.out"), "first\nsecond\nthird, not finished");
  const seen: string[] = [];
  await pkg.logs({ follow: false, onLine: (line) => seen.push(line) });
  expect(seen).toEqual(["first", "second", "third, not finished"]);
});


test("the native API can read imports without mounting or restarting for each folder", async () => {
  const { pkg } = packageWith();
  expect((await pkg.start({ ...startOptions, importFolders: [] })).ok).toBe(true);
  const config = JSON.parse(readFileSync(join(dataFolder, "engine-config", "native-2.6.0.json"), "utf8"));
  expect(config.imagesRoot).toBe("/");
});

// The Windows ways, with the platform set to Windows on any host. The program is the fake engine under the Windows name.

function windowsProgram(): string {
  const program = join(dataFolder, "engine-packages", "2.6.0", "aidm-api.exe");
  writeFileSync(program, fakeProgramScript({ reports: "2.6.0" }));
  chmodSync(program, 0o755);
  return program;
}

function windowsWays(commandLines: Map<number, string[]>, options: { taskkillEnds?: boolean } = {}) {
  return windowsRunner({ commandLine: (pid) => commandLines.get(pid), ...options });
}

test("on Windows the program is aidm-api.exe, started with its console hidden, and elsewhere aidm-api, with no such option", async () => {
  const program = windowsProgram();
  const windows = packageWith({ platform: "win32", runner: windowsWays(new Map()) });
  expect((await windows.pkg.start(startOptions)).ok).toBe(true);
  expect(windows.spawned).toEqual([{ argv: [program, "--config", join(dataFolder, "engine-config", "native-2.6.0.json")], windowsHide: true }]);
  expect((await windows.pkg.stop()).ok).toBe(true);

  const linux = packageWith({ platform: "linux" });
  expect((await linux.pkg.start(startOptions)).ok).toBe(true);
  expect(linux.spawned.map((entry) => [entry.argv[0], entry.windowsHide])).toEqual([[join(dataFolder, "engine-packages", "2.6.0", "aidm-api"), false]]);
});

test("on Windows a folder with only a program without the .exe name is not an installed package", async () => {
  const { pkg } = packageWith({ platform: "win32", runner: windowsWays(new Map()) });
  expect(pkg.isInstalled()).toBe(false);
  expect(await pkg.start(startOptions)).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { reason: "not_unpacked" } } });
  windowsProgram();
  expect(pkg.isInstalled()).toBe(true);
});

test("the program is started detached, with no input, its output in the file, and the hidden console option handed to the spawn", () => {
  const given: Array<Parameters<SpawnProcess>> = [];
  const spawn = engineSpawner((argv, options) => {
    given.push([argv, options]);
    return { pid: 4242, exited: new Promise<number>(() => {}), unref: () => {} };
  });
  mkdirSync(join(dataFolder, "logs"), { recursive: true });
  const outputFile = join(dataFolder, "logs", "native-engine.out");
  spawn(["aidm-api.exe", "--config", "c.json"], { cwd: dataFolder, outputFile, windowsHide: true });
  spawn(["aidm-api", "--config", "c.json"], { cwd: dataFolder, outputFile, windowsHide: false });
  expect(given.map(([argv, options]) => ({ argv, ...options, stdout: typeof options.stdout, stderr: typeof options.stderr }))).toEqual([
    { argv: ["aidm-api.exe", "--config", "c.json"], cwd: dataFolder, stdin: "ignore", stdout: "number", stderr: "number", detached: true, windowsHide: true },
    { argv: ["aidm-api", "--config", "c.json"], cwd: dataFolder, stdin: "ignore", stdout: "number", stderr: "number", detached: true, windowsHide: false },
  ]);
  expect(given[0]?.[1].stdout).toBe(given[0]?.[1].stderr as number);
});

for (const platform of ["linux", "darwin", "win32"] as const) {
  test(`on ${platform} the config file tells the task API to listen on this computer only`, async () => {
    if (platform === "win32") windowsProgram();
    const { pkg } = packageWith({ platform, runner: platform === "win32" ? windowsWays(new Map()) : systemRunner() });
    const started = await pkg.start(startOptions);
    expect(started.ok && started.value.address).toStartWith("http://127.0.0.1:");
    expect(JSON.parse(readFileSync(join(dataFolder, "engine-config", "native-2.6.0.json"), "utf8"))).toEqual({
      token: startOptions.token,
      host: "127.0.0.1",
      port: 0,
      parallelQueueProcessing: 1,
      odx_path: join(dataFolder, "engine-packages", "2.6.0", "engine"),
    });
  });
}

/** A program that is running, but that this run did not start, as after a restart of aidm-ui. */
function runningProgram(): number {
  const child = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  child.unref();
  pids.push(child.pid);
  return child.pid;
}

test("on Windows a program whose command line names our config file, quoted for its space, is ours: it is followed, then ended with taskkill and its tree", async () => {
  windowsProgram();
  const pid = runningProgram();
  const config = engineConfigFile(dataFolder, "2.6.0");
  expect(config).toContain(" ");
  const runner = windowsWays(new Map([[pid, [join(dataFolder, "engine-packages", "2.6.0", "aidm-api.exe"), "--config", config, "--test"]]]));
  const signals: number[] = [];
  const { pkg } = packageWith({ platform: "win32", runner, sendSignal: (target) => signals.push(target) });
  record = { pid, port: 3000, version: "2.6.0" };

  expect(await pkg.status()).toEqual({ ok: true, value: { state: "running", exitCode: null } });
  expect(runner.calls).toEqual([{ argv: windowsCommandLineQuery(pid), timeoutMs: 15_000 }]);

  expect((await pkg.stop()).ok).toBe(true);
  expect(runner.calls.filter((call) => call.argv[0] === "taskkill")).toEqual([{ argv: ["taskkill", "/PID", String(pid), "/T", "/F"], timeoutMs: 15_000 }]);
  // No signal: Windows has none that ends a tree.
  expect(signals).toEqual([]);
  expect(alive(pid)).toBe(false);
  expect(record).toBeNull();
});

test("on Windows a program that names another config file, or whose command line cannot be read, is not ours: it is left alone and forgotten", async () => {
  windowsProgram();
  const other = runningProgram();
  const unreadable = runningProgram();
  const runner = windowsWays(new Map([[other, ["C:\\aidm\\aidm-api.exe", "--config", engineConfigFile(dataFolder, "2.5.0")]]]));
  const { pkg } = packageWith({ platform: "win32", runner });

  for (const pid of [other, unreadable]) {
    record = { pid, port: 3000, version: "2.6.0" };
    expect(await pkg.status()).toEqual({ ok: true, value: { state: "stopped", exitCode: null } });
    expect((await pkg.stop()).ok).toBe(true);
    expect(alive(pid)).toBe(true);
    expect(record).toBeNull();
  }
  expect(runner.calls.filter((call) => call.argv[0] === "taskkill")).toEqual([]);
});

test("on Windows a program that taskkill does not end stays on record, and no second program is started next to it", async () => {
  windowsProgram();
  const runner = windowsWays(new Map(), { taskkillEnds: false });
  const { pkg, starts } = packageWith({ platform: "win32", runner });
  expect((await pkg.start(startOptions)).ok).toBe(true);
  expect(await pkg.stop()).toEqual({ ok: false, error: { code: "runtime.command_failed", data: { operation: "stop", reason: "still_running" } } });
  expect(await pkg.start(startOptions)).toEqual({ ok: false, error: { code: "runtime.start_failed", data: { reason: "previous_engine_running" } } });
  expect(starts).toHaveLength(1);
  expect(runner.calls.filter((call) => call.argv[0] === "taskkill")).toHaveLength(2);
});

// Command lines Windows printed for a task API that aidm-ui started (test-support/recorded/windows).

const recordedFolder = "C:\\Users\\Field Operator\\AppData\\Local\\aidm-ui";

test("a recorded Windows command line names our config file, compared without case and with either slash", () => {
  const line = recordedText("windows", "cim-command-line-engine").trim();
  const ours = win32.join(recordedFolder, "engine-config", "native-2.7.0.json");
  expect(usesConfig(line, ours, "win32")).toBe(true);
  expect(usesConfig(line, ours.toUpperCase(), "win32")).toBe(true);
  expect(usesConfig(line, ours.replaceAll("\\", "/"), "win32")).toBe(true);
  expect(usesConfig(line, win32.join(recordedFolder, "engine-config", "native-2.6.0.json"), "win32")).toBe(false);
});

test("a recorded Windows command line that names another config file is not ours", () => {
  const line = recordedText("windows", "cim-command-line-other-config").trim();
  expect(usesConfig(line, win32.join(recordedFolder, "engine-config", "native-2.7.0.json"), "win32")).toBe(false);
});
