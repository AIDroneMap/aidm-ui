import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fakeProgramScript } from "../../test-support/native-archive.ts";
import { systemRunner } from "../process/command-runner.ts";
import type { NativeProcess, Settings } from "../settings/settings.ts";
import { NativePackage, spawnEngine, type ChildState, type NativePackageDeps, type SpawnEngine } from "./native-package.ts";

const GiB = 1024 ** 3;

let dataFolder: string;
const pids: number[] = [];
let record: NativeProcess | null;

beforeEach(() => {
  dataFolder = mkdtempSync(join(os.tmpdir(), "aidm-ui-native-package-"));
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
  const spawn: SpawnEngine = (argv, options) => {
    const child = spawnEngine(argv, options);
    starts.push(child.pid);
    pids.push(child.pid);
    return child;
  };
  const children = new Map<number, ChildState>();
  const pkg = new NativePackage({
    variant: { kind: "native", url: "https://example.test/a.tar.gz", size: 1000, sha256: "ab".repeat(32), gpu: false },
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
  return { pkg, starts, children };
}

const startOptions = { hostPort: 0, token: "a-secret-token", memoryBytes: null, cpus: null, engineDataFolder: os.tmpdir(), gpu: false };

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

test("the command line of the program names its config file and holds no token", async () => {
  if (process.platform !== "linux") return;
  const { pkg, starts } = packageWith();
  expect((await pkg.start(startOptions)).ok).toBe(true);
  const shown = readFileSync(`/proc/${starts[0]}/cmdline`, "utf8").split("\0");
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
