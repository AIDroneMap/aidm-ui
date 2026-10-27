import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { currentAuth } from "../auth/current.ts";
import { Sessions } from "../auth/sessions.ts";
import { openDatabase } from "../db/database.ts";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { EngineMonitor, type EngineMonitorDeps } from "../engines/engine-monitor.ts";
import { EngineStore } from "../engines/engine-store.ts";
import { LocalEngineManager, type LocalEngineDeps } from "../local-engine/manager.ts";
import { CONTAINER_NAME, type ImageSource } from "../packages/container-package.ts";
import { MacSetup, type MacSetupDeps } from "../runtimes/apple-container-installer.ts";
import type { CommandRunner } from "../process/command-runner.ts";
import type { RuntimeId } from "../runtimes/runtime.ts";
import { EventStreams } from "../http/event-streams.ts";
import type { FreeBytes } from "../machine/disk.ts";
import { ManifestService, type ManifestServiceDeps } from "../manifest/manifest-service.ts";
import { MachineChecks } from "../machine/machine-checks.ts";
import { RuntimeSetup, type PrivilegedRunner } from "../runtimes/podman-setup.ts";
import { OS_RELEASE_FILE, type SystemFiles } from "../runtimes/setup-command.ts";
import { UpdateCheckScheduler } from "../manifest/update-check.ts";
import { RunStore } from "../runs/run-store.ts";
import { RunTracker } from "../runs/run-tracker.ts";
import { SAMPLE_DATASET, type SampleDatasetEntry } from "../sample/sample-dataset.ts";
import { SampleJob, type SampleJobDeps } from "../sample/sample-job.ts";
import { listen, LOOPBACK, type Listener } from "../http/listener.ts";
import { MAX_RAISED_BODY_BYTES } from "../http/limits.ts";
import { createRoutes, fallbackFetch } from "../http/routes.ts";
import type { RouteContext } from "../http/route-table.ts";
import type { AssetMap } from "../http/static-assets.ts";
import { Settings } from "../settings/settings.ts";
import { FakePrivilegedRunner, FakeSystemFiles } from "../../test-support/fake-privileged.ts";
import { FakeImages } from "../../test-support/fake-images.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { ScriptedRunner, recordedText } from "../../test-support/scripted-runner.ts";
import { recordedMachine } from "../../test-support/recorded-machine.ts";
import { runnerWithSystemd } from "../../test-support/native-archive.ts";

const GiB = 1024 ** 3;

export const TEST_IDENTITY = { app: "aidm-ui", version: "9.9.9", instance: "abc" } as const;

export interface Harness {
  /** `http://127.0.0.1:<port>` */
  base: string;
  port: number;
  ctx: RouteContext;
  settings: Settings;
  sessions: Sessions;
  engines: EngineMonitor;
  engineStore: EngineStore;
  localEngine: LocalEngineManager;
  /** The setup of Podman, which never reaches a real prompt in a test. */
  runtimeSetup: RuntimeSetup;
  /** The privileged runner the setup uses; by default it is not authorised. */
  privileged: PrivilegedRunner;
  /** The container runtimes the local engine can use, in memory. */
  runtimes: Partial<Record<RuntimeId, FakeRuntime>>;
  /** The in-memory image source the local engine downloads from, unless the test passed `images` of its own. */
  images: FakeImages;
  runs: RunStore;
  tracker: RunTracker;
  sample: SampleJob;
  manifests: ManifestService;
  updateChecks: UpdateCheckScheduler;
  /** Where downloads and run logs go. */
  dataFolder: string;
  /** Milliseconds the throttle sees as now; move it to move time. */
  clock: { now: number };
  /** Every line the server wrote to its log. */
  logs: string[];
  rebinds: string[];
  /**
   * Stops the server. The containers of the fake runtimes are removed unless
   * `leaveEngines` is set, which is what a stopped aidm-ui does: the engine goes on.
   */
  stop(options?: { leaveEngines?: boolean }): Promise<void>;
}

/**
 * The routes on a listener of their own with an in-memory database. It uses
 * the same guard and the same hook choice as the real server, but the listener
 * never moves when the LAN switch does, so a test picks the interface itself.
 */
export function openHarness(
  options: {
    hostname?: string;
    assets?: AssetMap;
    /** What a rebind does after it is recorded; throw to make the listener fail to move. */
    rebind?: (hostname: string) => Promise<void>;
    /** How often the engines are polled; short, so tests do not wait. */
    enginePollMs?: number;
    /** Swaps the name lookup of the address rule, so a test can move a name between networks. */
    resolve?: EngineMonitorDeps["resolve"];
    /** Swaps the way the monitor reaches an engine, for names that only the test knows. */
    clientFor?: EngineMonitorDeps["clientFor"];
    /** How often the runs are polled. */
    runPollMs?: number;
    /** Swaps the way the sample job and the run tracker reach an engine, for tests that make a call fail. */
    runClientFor?: SampleJobDeps["clientFor"];
    /** The sample dataset entry; tests point it at a fake file server. */
    sampleDataset?: SampleDatasetEntry;
    freeBytes?: FreeBytes;
    /** Where container images come from; default: a FakeImages. A test passes registryImages to download from a fake registry. */
    images?: ImageSource;
    /** The times and the fetch of the image downloader. */
    imageDownload?: LocalEngineDeps["imageDownload"];
    /** The fake container runtimes by id; default: one Podman that works. */
    runtimes?: Partial<Record<RuntimeId, FakeRuntime>>;
    /** Answers the NVIDIA driver and toolkit commands of the graphics card checks; default: none is installed. */
    gpuRunner?: CommandRunner;
    /** The computer the local engine is sized for; default: Linux on x64 with 32 GiB and 8 cores. */
    localMachine?: LocalEngineDeps["machine"];
    /** The port the local engine is published on; a test passes one that repeats to reuse a port. */
    freePort?: LocalEngineDeps["freePort"];
    /** What runs tar and systemctl for a native package; default: the real tar, and no systemd. */
    runner?: LocalEngineDeps["runner"];
    /** How a native package is started and downloaded; a test records the start or points the download at a fake file server. */
    native?: LocalEngineDeps["native"];
    /** How long a new engine version may stay silent before an update is undone. */
    updateReadyTimeoutMs?: LocalEngineDeps["updateReadyTimeoutMs"];
    /** Passed to the log of the local engine, to make it rotate or retry sooner. */
    localLog?: LocalEngineDeps["logOptions"];
    /** How long a freshly started local engine may stay silent and still be starting. */
    startingGraceMs?: number;
    /** Waits between pull attempts and before each restart of a crashed local engine; default: no wait. */
    sleep?: LocalEngineDeps["sleep"];
    /** The clock of the engine manager, for the time of the next restart and how long the engine has answered. */
    localNow?: LocalEngineDeps["now"];
    /**
     * Where the manifest comes from. Without a fetch of its own the service
     * has no network at all, so a test can only reach a fake release server on purpose.
     */
    manifest?: Partial<Pick<ManifestServiceDeps, "releasesUrl" | "fetch" | "keys" | "uiVersion">>;
    /** How often the scheduler looks at whether a check is due; short, so tests do not wait. */
    updateCheckMs?: number;
    /** The computer the machine check reads; default: a Linux computer with 32 GiB and no container runtime. */
    machine?: RouteContext["machine"];
    /**
     * The Mac setup, for a test that runs the install on a Mac: the runner that
     * answers the commands and the pins and waits to change. Without it there is none.
     */
    macSetup?: Omit<MacSetupDeps, "dataFolder" | "log" | "runner"> & { runner: CommandRunner };
    /** process.arch of the computer, for the reference time. */
    architecture?: string;
    /** Swaps parts of the Podman setup: the privileged runner, the files and the programs run as the operator. */
    setup?: { privileged?: PrivilegedRunner; files?: SystemFiles; runner?: CommandRunner; operator?: string };
    /**
     * A data folder to keep, with a database file in it, so that a second
     * harness on the same folder is a restart. Default: a folder of its own,
     * removed on stop, with a database in memory.
     */
    dataFolder?: string;
  } = {},
): Harness {
  const ownFolder = options.dataFolder === undefined ? mkdtempSync(join(os.tmpdir(), "aidm-ui-test-")) : undefined;
  const dataFolder = options.dataFolder ?? (ownFolder as string);
  const db = options.dataFolder === undefined ? new Database(":memory:", { strict: true }) : openDatabase(dataFolder);
  db.run("PRAGMA foreign_keys = ON");
  applyMigrations(db, migrations);
  const settings = new Settings(db);
  const sessions = new Sessions();
  const clock = { now: Date.now() };
  const logs: string[] = [];
  const rebinds: string[] = [];
  let listener: Listener | undefined;
  const log = (line: string) => logs.push(line);
  const engineStore = new EngineStore(db);
  const engines = new EngineMonitor({
    store: engineStore,
    intervalMs: options.enginePollMs ?? 100,
    log,
    resolve: options.resolve,
    clientFor: options.clientFor,
    startingGraceMs: options.startingGraceMs,
  });
  const runs = new RunStore(db);
  const tracker = new RunTracker({
    runs,
    engines: engineStore,
    dataFolder,
    intervalMs: options.runPollMs ?? 50,
    log,
    clientFor: options.runClientFor,
  });
  const manifests = new ManifestService({
    settings,
    releasesUrl: options.manifest?.releasesUrl,
    fetch:
      options.manifest?.fetch ??
      (async () => {
        throw new Error("The test harness has no network.");
      }),
    keys: options.manifest?.keys,
    uiVersion: options.manifest?.uiVersion ?? TEST_IDENTITY.version,
    now: () => clock.now,
    log,
  });
  const runtimes = options.runtimes ?? { podman: new FakeRuntime() };
  const machine = options.machine ?? recordedMachine();
  const machineChecks = new MachineChecks({
    machine,
    settings,
    now: () => clock.now,
  });
  const fakeImages = new FakeImages();
  const images = options.images ?? fakeImages;
  const localEngine = new LocalEngineManager({
    settings,
    engineStore,
    monitor: engines,
    manifests,
    runs,
    runtimes: (id) => runtimes[id] ?? null,
    detectRuntimes: () => Promise.all(Object.values(runtimes).map((runtime) => runtime.detect())),
    runner: options.gpuRunner ?? new ScriptedRunner([]),
    machine: options.localMachine ?? { platform: "linux", arch: "x64", totalMemory: 32 * GiB, cpuCount: 8 },
    dataFolder,
    // Not the disk of the machine that runs the tests.
    freeBytes: options.freeBytes ?? (() => 1024 * GiB),
    log,
    macSetup: options.macSetup === undefined ? undefined : new MacSetup({ ...options.macSetup, dataFolder, log }),
    localEngineOffer: async () => (await machineChecks.read()).localEngine,
    sleep: options.sleep ?? (async () => {}),
    images,
    imageDownload: options.imageDownload,
    now: options.localNow,
    freePort: options.freePort,
    logOptions: options.localLog,
    updateReadyTimeoutMs: options.updateReadyTimeoutMs,
    nativeRunner: options.runner ?? runnerWithSystemd(false),
    native: { stopGraceMs: 2000, logPollMs: 25, wrapWatchMs: 200, ...options.native },
  });

  const sample = new SampleJob({
    dataset: options.sampleDataset ?? SAMPLE_DATASET,
    dataFolder,
    runs,
    tracker,
    engines,
    engineStore,
    architecture: options.architecture ?? process.arch,
    log,
    freeBytes: options.freeBytes,
    clientFor: options.runClientFor,
    localMemoryCap: () => localEngine.memoryCap(),
  });

  const updateChecks = new UpdateCheckScheduler({
    settings,
    manifests,
    now: () => clock.now,
    intervalMs: options.updateCheckMs ?? 50,
    log,
  });

  const privileged = options.setup?.privileged ?? new FakePrivilegedRunner();
  const runtimeSetup = new RuntimeSetup({
    platform: options.localMachine?.platform ?? "linux",
    operator: options.setup?.operator ?? "operator",
    privileged,
    files: options.setup?.files ?? new FakeSystemFiles({ [OS_RELEASE_FILE]: recordedText("os-release", "debian-13") }),
    runner: options.setup?.runner ?? new ScriptedRunner([]),
    checks: machineChecks,
    install: () => localEngine.install(),
    log,
  });

  const ctx: RouteContext = {
    identity: TEST_IDENTITY,
    assets: options.assets ?? new Map(),
    settings,
    sessions,
    engines,
    engineStore,
    localEngine,
    streams: new EventStreams(sessions),
    tracker,
    sample,
    manifests,
    machine,
    machineChecks,
    runtimeSetup,
    auth: () => currentAuth(settings, sessions),
    listeningPort: () => listener?.port ?? 0,
    rebind: async (hostname) => {
      rebinds.push(hostname);
      await options.rebind?.(hostname);
    },
    now: () => clock.now,
    log,
  };
  listener = listen({
    hostname: options.hostname ?? LOOPBACK,
    port: 0,
    routes: createRoutes(ctx),
    fetch: fallbackFetch(),
    maxRequestBodySize: MAX_RAISED_BODY_BYTES,
  });
  engines.start();
  tracker.start();
  // As the real server does: an engine that still runs is followed again, one that is gone is started.
  void localEngine.resume();
  updateChecks.start();

  let stopped = false;
  return {
    base: `http://${LOOPBACK}:${listener.port}`,
    port: listener.port,
    ctx,
    settings,
    sessions,
    engines,
    engineStore,
    localEngine,
    runtimeSetup,
    privileged,
    runtimes,
    images: fakeImages,
    runs,
    tracker,
    sample,
    manifests,
    updateChecks,
    dataFolder,
    clock,
    logs,
    rebinds,
    async stop(stopOptions = {}) {
      if (stopped) return;
      stopped = true;
      await listener?.stop();
      await updateChecks.stop();
      await sample.stop();
      await tracker.stop();
      await localEngine.close();
      await engines.stop();
      // The containers of the fake runtimes hold fake engines that listen on real ports.
      if (!stopOptions.leaveEngines) {
        for (const runtime of Object.values(runtimes)) await runtime.remove(CONTAINER_NAME);
        endNativeEngine(settings);
      }
      db.close();
      if (ownFolder !== undefined) rmSync(ownFolder, { recursive: true, force: true });
    },
  };
}

/** Ends the program of a native package, the way removing a container ends a fake one. */
function endNativeEngine(settings: Settings): void {
  const record = settings.get("local.native");
  if (record === null) return;
  try {
    process.kill(-record.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** An IPv4 address of this computer that is not loopback, or undefined when it has none. */
/**
 * A test that needs an address on the local network. Without one it is
 * skipped, so it can run on a laptop without a network, unless
 * AIDM_REQUIRE_LAN_TESTS is 1: then it fails, so CI cannot pass with these
 * tests skipped.
 */
export function lanTest(name: string, body: (address: string) => Promise<void> | void, timeoutMs?: number): void {
  const address = lanAddress();
  if (address !== undefined) {
    test(name, () => body(address), timeoutMs);
  } else if (process.env.AIDM_REQUIRE_LAN_TESTS === "1") {
    test(name, () => {
      throw new Error("This test needs an IPv4 address on the local network, and AIDM_REQUIRE_LAN_TESTS=1 says it may not be skipped.");
    });
  } else {
    test.skip(name, () => {});
  }
}

export function lanAddress(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

/** A port with nothing on it, and nothing on the next one either. */
export async function freePort(): Promise<number> {
  for (;;) {
    const probeServer = Bun.serve({ port: 0, hostname: LOOPBACK, fetch: () => new Response() });
    const port = probeServer.port as number;
    await probeServer.stop(true);
    try {
      const next = Bun.serve({ port: port + 1, hostname: LOOPBACK, fetch: () => new Response() });
      await next.stop(true);
      return port;
    } catch {
      // The next port is taken, try again.
    }
  }
}

/** Calls a check until it holds, for things the server does just after answering. */
export async function eventually(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("The condition did not hold in time.");
    await Bun.sleep(25);
  }
}
