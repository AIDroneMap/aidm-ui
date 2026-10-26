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
import { EventStreams } from "../http/event-streams.ts";
import type { FreeBytes } from "../machine/disk.ts";
import { RunStore } from "../runs/run-store.ts";
import { RunTracker } from "../runs/run-tracker.ts";
import { SAMPLE_DATASET, type SampleDatasetEntry } from "../sample/sample-dataset.ts";
import { SampleJob, type SampleJobDeps } from "../sample/sample-job.ts";
import { listen, LOOPBACK, type Listener } from "../http/listener.ts";
import { createRoutes, fallbackFetch } from "../http/routes.ts";
import type { RouteContext } from "../http/route-table.ts";
import type { AssetMap } from "../http/static-assets.ts";
import { Settings } from "../settings/settings.ts";
import { recordedMachine } from "../../test-support/recorded-machine.ts";

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
  runs: RunStore;
  tracker: RunTracker;
  sample: SampleJob;
  /** Where downloads and run logs go. */
  dataFolder: string;
  /** Milliseconds the throttle sees as now; move it to move time. */
  clock: { now: number };
  /** Every line the server wrote to its log. */
  logs: string[];
  rebinds: string[];
  stop(): Promise<void>;
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
    /** The computer the machine check reads; default: a Linux computer with 32 GiB and no container runtime. */
    machine?: RouteContext["machine"];
    /** process.arch of the computer, for the reference time. */
    architecture?: string;
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
  });

  const ctx: RouteContext = {
    identity: TEST_IDENTITY,
    assets: options.assets ?? new Map(),
    settings,
    sessions,
    engines,
    engineStore,
    streams: new EventStreams(sessions),
    tracker,
    sample,
    machine: options.machine ?? recordedMachine(),
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
  });
  engines.start();
  tracker.start();

  return {
    base: `http://${LOOPBACK}:${listener.port}`,
    port: listener.port,
    ctx,
    settings,
    sessions,
    engines,
    engineStore,
    runs,
    tracker,
    sample,
    dataFolder,
    clock,
    logs,
    rebinds,
    async stop() {
      await listener?.stop();
      await sample.stop();
      await tracker.stop();
      await engines.stop();
      db.close();
      if (ownFolder !== undefined) rmSync(ownFolder, { recursive: true, force: true });
    },
  };
}

/** An IPv4 address of this computer that is not loopback, or undefined when it has none. */
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
