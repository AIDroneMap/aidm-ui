import { PresetStore } from "../presets/preset-store.ts";
import { LinkStore } from "../projects/link-store.ts";
import { ProjectRuns } from "../projects/project-runs.ts";
import { RunInputs } from "../projects/run-inputs.ts";
import { ImportStore } from "../projects/import-store.ts";
import { PhotoStore } from "../photos/photo-store.ts";
import { mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { parseCommandLine, parseSetupCommand } from "./cli.ts";
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
import { LocalEngineManager } from "../local-engine/manager.ts";
import { freeBytes } from "../machine/disk.ts";
import { systemRunner } from "../process/command-runner.ts";
import { recordingRunner } from "../process/recording-runner.ts";
import { MacSetup } from "../runtimes/apple-container-installer.ts";
import { AppleNetwork } from "../runtimes/apple-network.ts";
import { RuntimeSetup, pkexecRunner } from "../runtimes/podman-setup.ts";
import { allRuntimes, containerRuntime } from "../runtimes/registry.ts";
import { runSetupFromCommandLine, SETUP_EXIT, systemFiles } from "../runtimes/setup-command.ts";
import { EventStreams } from "../http/event-streams.ts";
import { MachineChecks } from "../machine/machine-checks.ts";
import { systemMachine } from "../machine/system.ts";
import { ManifestService } from "../manifest/manifest-service.ts";
import { UpdateCheckScheduler } from "../manifest/update-check.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { ProjectDeletion } from "../projects/project-deletion.ts";
import { UploadStore } from "../projects/upload-store.ts";
import { RunStore } from "../runs/run-store.ts";
import { DEFAULT_RUN_POLL_INTERVAL_MS, RunTracker } from "../runs/run-tracker.ts";
import { SampleJob } from "../sample/sample-job.ts";
import { SAMPLE_DATASET } from "../sample/sample-dataset.ts";
import { ALL_INTERFACES, listen, LOOPBACK, type Listener } from "../http/listener.ts";
import { MAX_RAISED_BODY_BYTES } from "../http/limits.ts";
import { createRoutes, fallbackFetch } from "../http/routes.ts";
import { UnreachableLines } from "../task-api/unreachable-lines.ts";
import { entryScriptOf, type AssetMap } from "../http/static-assets.ts";
import { Settings } from "../settings/settings.ts";
import { loggingRunner } from "../process/logging-runner.ts";
import { openDiagnosisLog } from "./diagnosis-log.ts";
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
  /** `logged`: the problem is in the diagnosis log, and on the terminal, already. */
  | { kind: "failed"; problem: string; logged?: boolean };

function urlFor(port: number): string {
  return `http://${LOOPBACK}:${port}/`;
}

function operatorName(): string {
  try {
    return os.userInfo().username;
  } catch {
    // No entry for this user: the setup step then says it cannot run.
    return "";
  }
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

  const entry = entryScriptOf(options.assets);
  const identity: InstanceIdentity = {
    app: "aidm-ui",
    version: options.version,
    instance: instanceId(dataFolder),
    ...(entry === null ? {} : { entry }),
  };

  const isOurs = async (port: number) => (await probe(port))?.instance === identity.instance;
  const attach = async (port: number): Promise<StartResult> => {
    const url = urlFor(port);
    // A second copy, which stops at once: its lines go to its own terminal, and the log is the running copy's.
    await options.openBrowser(url, options.log);
    return { kind: "attached", url };
  };

  // A copy that uses this data folder may already run, on any port of the range.
  const lock = readLock(dataFolder);
  if (lock && isProcessAlive(lock.pid) && (await isOurs(lock.port))) return attach(lock.port);

  // The readable log for diagnosis, on by default: the terminal and logs/aidm-ui.log. No engine token reaches it.
  let tokens: () => string[] = () => [];
  const log = openDiagnosisLog({ dataFolder, terminal: options.log, secrets: () => tokens() });
  log(`aidm-ui ${options.version} starts, on ${process.platform} ${process.arch}, with the data folder ${dataFolder}`);

  const db = openDatabase(dataFolder);
  let databaseBelongsToServer = false;
  try {
    const settings = new Settings(db);
    const sessions = new Sessions();
    const engineStore = new EngineStore(db, log);
    tokens = () => engineStore.list().map((engine) => engine.token);
    // One record of each engine's failures for every caller, so a long outage reads as one summary a minute.
    const unreachable = new UnreachableLines(log);
    const engines = new EngineMonitor({ store: engineStore, intervalMs: DEFAULT_POLL_INTERVAL_MS, log: log, unreachable });
    const runStore = new RunStore(db);
    const projects = new ProjectStore(db, SAMPLE_DATASET.imageCount);
    const projectDeletion = new ProjectDeletion(projects, engineStore, dataFolder, log);
    const imports = new ImportStore(db, dataFolder);
    const tracker = new RunTracker({
    beginResultsWrite: id => projectDeletion.beginWrite(id),
      runs: runStore,
      engines: engineStore,
      dataFolder,
      intervalMs: DEFAULT_RUN_POLL_INTERVAL_MS,
      log: log,
      unreachable,
      // The local engine's task folders are on this computer, so the run summary reads the engine's own log.json there.
      taskFolder: (engine, taskUuid) => (engine.kind === "local" ? localEngine.localTaskFolder(taskUuid) : null),
    });
    const manifests = new ManifestService({
      settings,
      uiVersion: options.version,
      now: Date.now,
      log: log,
    });
    // Every command a runtime or a check runs gets a line in the diagnosis log.
    let runner = loggingRunner(systemRunner(), log);
    if (commandLine.recordRuntimeCommands) {
      // A diagnostic for the maintainer, so the line goes to the terminal and the interface never hears of it.
      const file = join(dataFolder, "diagnostics", "runtime-commands.jsonl");
      runner = recordingRunner(runner, {
        file,
        version: options.version,
        secrets: () => engineStore.list().filter((engine) => engine.kind === "local").map((engine) => engine.token),
      });
      log(`Recording every runtime command to ${file}. Turn it off by starting without --record-runtime-commands.`);
    }
    const machine = systemMachine(dataFolder, runner);
    const machineChecks = new MachineChecks({ machine, settings, now: Date.now });
    const onMac = process.platform === "darwin";
    // The checks of an engine that runs and does not answer, and the subnet of the tool's network (ADR 0006).
    const appleNetwork = onMac ? new AppleNetwork({ runner, log }) : undefined;
    const localEngine = new LocalEngineManager({
      settings,
      engineStore,
      monitor: engines,
      manifests,
      runs: runStore,
      runtimes: (id) => containerRuntime(id, runner, log),
      detectRuntimes: () => Promise.all(allRuntimes(runner, process.platform).map((runtime) => runtime.detect())),
      runner,
      machine: {
        platform: process.platform,
        arch: process.arch,
        totalMemory: os.totalmem(),
        cpuCount: os.availableParallelism(),
      },
      dataFolder,
      freeBytes,
      log: log,
      macSetup: onMac ? new MacSetup({ runner, dataFolder, freeBytes, log: log, network: appleNetwork }) : undefined,
      appleNetwork,
      localEngineOffer: async () => (await machineChecks.read()).localEngine,
      nativeRunner: runner,
    });
    const sample = new SampleJob({
      dataset: SAMPLE_DATASET,
      dataFolder,
      runs: runStore,
      tracker,
      engines,
      engineStore,
      architecture: process.arch,
      log: log,
      unreachable,
      localMemoryCap: () => localEngine.memoryCap(),
    });
    const runtimeSetup = new RuntimeSetup({
      platform: process.platform,
      operator: operatorName(),
      privileged: pkexecRunner(process.execPath),
      files: systemFiles(),
      runner,
      checks: machineChecks,
      install: () => localEngine.install(),
      log: log,
    });
    const updateChecks = new UpdateCheckScheduler({ settings, manifests, now: Date.now, log: log });
    let listener: Listener | undefined;

    const links = new LinkStore(db);
  const photos = new PhotoStore(db, dataFolder, imports);
    const projectRuns = new ProjectRuns({ projects, projectDeletion, links, inputs: new RunInputs(db, dataFolder, imports), photos, engines: engineStore, runs: runStore, tracker, settings, log });
    const routes = createRoutes({
      identity,
      presets: new PresetStore(db),
      projects,
      projectDeletion,
      links,
    uploads: new UploadStore(db, dataFolder),
      photos,
      projectRuns,
      imports,
      assets: options.assets,
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
        await listener?.rebind(hostname);
      },
      now: Date.now,
      log: log,
    });
    const fetch = fallbackFetch();
    // The command line wins over the stored setting, which wins over the default.
    const first = commandLine.port ?? settings.get("server.port") ?? DEFAULT_PORT;
    const last = Math.min(first + PORT_ATTEMPTS - 1, 65535);
    const hostname = settings.get("lan.enabled") ? ALL_INTERFACES : LOOPBACK;

    for (let port = first; port <= last; port++) {
      try {
        listener = listen({ hostname, port, routes, fetch, maxRequestBodySize: MAX_RAISED_BODY_BYTES });
      } catch (error) {
        if (!isAddressInUse(error)) throw error;
        if (await isOurs(port)) return await attach(port);
        continue;
      }

      const running = listener;
      writeLock(dataFolder, { pid: process.pid, port });
      const url = urlFor(port);
      log(`aidm-ui is running at ${url}`);
      databaseBelongsToServer = true;
      engines.start();
      tracker.start();
      // In the background: a slow runtime must not delay the browser, and neither call can fail.
      void localEngine.refreshRuntimes();
      void localEngine.resume();
      updateChecks.start();
      await options.openBrowser(url, log);
      const result: StartResult = {
        kind: "started",
        url,
        port,
        dataFolder,
        async stop() {
          // No request can arrive once the listener is down, and nothing may use the database after it closes.
          await running.stop();
          await updateChecks.stop();
          await projectRuns.stop();
          await sample.stop();
          await tracker.stop();
          // Stops following the log. The engine keeps running when aidm-ui stops.
          await localEngine.close();
          await engines.stop();
          db.close();
          removeLock(dataFolder, process.pid);
        },
      };
      return result;
    }

    const problem = `No free port from ${first} to ${last}. Close the program that uses them or pass --port.`;
    log(problem);
    return { kind: "failed", problem, logged: true };
  } finally {
    // A running server keeps the database until it stops.
    if (!databaseBelongsToServer) db.close();
  }
}

export async function runFromCommandLine(assets: AssetMap, version: string): Promise<void> {
  // The step that runs as the administrator touches nothing of the operator's: it is handled before the data folder is read.
  const setup = parseSetupCommand(process.argv.slice(2));
  if (setup !== null) {
    if (!setup.ok) {
      console.error(setup.problem);
      process.exit(SETUP_EXIT.badArguments);
    }
    process.exit(await runSetupFromCommandLine(setup.user));
  }

  const log = (line: string) => console.log(line);
  const result = await startAidmUi({
    argv: process.argv.slice(2),
    env: process.env,
    platform: process.platform,
    homeDir: os.homedir(),
    cwd: process.cwd(),
    assets,
    version,
    openBrowser: platformOpener(process.platform),
    log,
  });

  switch (result.kind) {
    case "failed":
      if (result.logged !== true) console.error(result.problem);
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
