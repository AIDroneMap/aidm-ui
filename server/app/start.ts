import { mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import { parseCommandLine } from "./cli.ts";
import { resolveDataFolder } from "./data-folder.ts";
import {
  instanceId,
  isProcessAlive,
  probe,
  readLock,
  removeLock,
  writeLock,
  type InstanceIdentity,
} from "./instance.ts";
import { platformOpener, type OpenBrowser } from "./open-browser.ts";
import { currentAuth } from "../auth/current.ts";
import { Sessions } from "../auth/sessions.ts";
import { openDatabase } from "../db/database.ts";
import { DEFAULT_POLL_INTERVAL_MS, EngineMonitor } from "../engines/engine-monitor.ts";
import { EngineStore } from "../engines/engine-store.ts";
import { EventStreams } from "../http/event-streams.ts";
import { systemMachine } from "../machine/system.ts";
import { ManifestService } from "../manifest/manifest-service.ts";
import { UpdateCheckScheduler } from "../manifest/update-check.ts";
import { RunStore } from "../runs/run-store.ts";
import { DEFAULT_RUN_POLL_INTERVAL_MS, RunTracker } from "../runs/run-tracker.ts";
import { SampleJob } from "../sample/sample-job.ts";
import { SAMPLE_DATASET } from "../sample/sample-dataset.ts";
import { ALL_INTERFACES, listen, LOOPBACK, type Listener } from "../http/listener.ts";
import { createRoutes, fallbackFetch } from "../http/routes.ts";
import type { AssetMap } from "../http/static-assets.ts";
import { Settings } from "../settings/settings.ts";
import { DEFAULT_PORT } from "../../shared/api-types.ts";

/** 8823, 8824, ... 8832 */
export const PORT_ATTEMPTS = 10;

export interface StartOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homeDir: string;
  cwd: string;
  assets: AssetMap;
  version: string;
  openBrowser: OpenBrowser;
  log: (line: string) => void;
}

export type StartResult =
  | { kind: "started"; url: string; port: number; dataFolder: string; stop(): Promise<void> }
  | { kind: "attached"; url: string }
  | { kind: "failed"; problem: string };

function urlFor(port: number): string {
  return `http://${LOOPBACK}:${port}/`;
}

function isAddressInUse(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "EADDRINUSE";
}

export async function startAidmUi(options: StartOptions): Promise<StartResult> {
  const parsed = parseCommandLine(options.argv);
  if (!parsed.ok) return { kind: "failed", problem: parsed.problem };
  const { commandLine } = parsed;

  const requestedFolder = resolveDataFolder({
    platform: options.platform,
    env: options.env,
    homeDir: options.homeDir,
    cwd: options.cwd,
    flag: commandLine.dataFolder,
  });
  mkdirSync(requestedFolder, { recursive: true, mode: 0o700 });
  // The real path, so that a symlink or another spelling of the same folder
  // gives the same instance and the second copy attaches.
  const dataFolder = realpathSync.native(requestedFolder);

  const identity: InstanceIdentity = {
    app: "aidm-ui",
    version: options.version,
    instance: instanceId(dataFolder),
  };

  const isOurs = async (port: number) => (await probe(port))?.instance === identity.instance;
  const attach = async (port: number): Promise<StartResult> => {
    const url = urlFor(port);
    await options.openBrowser(url);
    return { kind: "attached", url };
  };

  // A copy that uses this data folder may already run, on any port of the range.
  const lock = readLock(dataFolder);
  if (lock && isProcessAlive(lock.pid) && (await isOurs(lock.port))) return attach(lock.port);

  const db = openDatabase(dataFolder);
  let databaseBelongsToServer = false;
  try {
    const settings = new Settings(db);
    const sessions = new Sessions();
    const engineStore = new EngineStore(db, options.log);
    const engines = new EngineMonitor({ store: engineStore, intervalMs: DEFAULT_POLL_INTERVAL_MS, log: options.log });
    const runStore = new RunStore(db);
    const tracker = new RunTracker({
      runs: runStore,
      engines: engineStore,
      dataFolder,
      intervalMs: DEFAULT_RUN_POLL_INTERVAL_MS,
      log: options.log,
    });
    const sample = new SampleJob({
      dataset: SAMPLE_DATASET,
      dataFolder,
      runs: runStore,
      tracker,
      engines,
      engineStore,
      architecture: process.arch,
      log: options.log,
    });
    const manifests = new ManifestService({
      settings,
      uiVersion: options.version,
      now: Date.now,
      log: options.log,
    });
    const updateChecks = new UpdateCheckScheduler({ settings, manifests, now: Date.now, log: options.log });
    let listener: Listener | undefined;

    const routes = createRoutes({
      identity,
      assets: options.assets,
      settings,
      sessions,
      engines,
      engineStore,
      streams: new EventStreams(sessions),
      tracker,
      sample,
      manifests,
      machine: systemMachine(dataFolder),
      auth: () => currentAuth(settings, sessions),
      listeningPort: () => listener?.port ?? 0,
      rebind: async (hostname) => {
        await listener?.rebind(hostname);
      },
      now: Date.now,
      log: options.log,
    });
    const fetch = fallbackFetch();
    // The command line wins over the stored setting, which wins over the default.
    const first = commandLine.port ?? settings.get("server.port") ?? DEFAULT_PORT;
    const last = Math.min(first + PORT_ATTEMPTS - 1, 65535);
    const hostname = settings.get("lan.enabled") ? ALL_INTERFACES : LOOPBACK;

    for (let port = first; port <= last; port++) {
      try {
        listener = listen({ hostname, port, routes, fetch });
      } catch (error) {
        if (!isAddressInUse(error)) throw error;
        if (await isOurs(port)) return await attach(port);
        continue;
      }

      const running = listener;
      writeLock(dataFolder, { pid: process.pid, port });
      const url = urlFor(port);
      options.log(`aidm-ui is running at ${url}`);
      databaseBelongsToServer = true;
      engines.start();
      tracker.start();
      updateChecks.start();
      await options.openBrowser(url);
      const result: StartResult = {
        kind: "started",
        url,
        port,
        dataFolder,
        async stop() {
          // No request can arrive once the listener is down, and nothing may use the database after it closes.
          await running.stop();
          await updateChecks.stop();
          await sample.stop();
          await tracker.stop();
          await engines.stop();
          db.close();
          removeLock(dataFolder, process.pid);
        },
      };
      return result;
    }

    return {
      kind: "failed",
      problem: `No free port from ${first} to ${last}. Close the program that uses them or pass --port.`,
    };
  } finally {
    // A running server keeps the database until it stops.
    if (!databaseBelongsToServer) db.close();
  }
}

export async function runFromCommandLine(assets: AssetMap, version: string): Promise<void> {
  const log = (line: string) => console.log(line);
  const result = await startAidmUi({
    argv: process.argv.slice(2),
    env: process.env,
    platform: process.platform,
    homeDir: os.homedir(),
    cwd: process.cwd(),
    assets,
    version,
    openBrowser: platformOpener(process.platform, log),
    log,
  });

  switch (result.kind) {
    case "failed":
      console.error(result.problem);
      process.exit(1);
    case "attached":
      log(`aidm-ui is already running at ${result.url}`);
      process.exit(0);
    case "started": {
      const shutDown = async () => {
        await result.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutDown);
      process.on("SIGTERM", shutDown);
    }
  }
}
