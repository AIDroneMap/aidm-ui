import { mkdirSync } from "node:fs";
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
import { createRoutes, fallbackFetch } from "../http/routes.ts";
import type { AssetMap } from "../http/static-assets.ts";

export const DEFAULT_PORT = 8823;
/** 8823, 8824, ... 8832 */
export const PORT_ATTEMPTS = 10;
export const LOOPBACK = "127.0.0.1";

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

  const dataFolder = resolveDataFolder({
    platform: options.platform,
    env: options.env,
    homeDir: options.homeDir,
    cwd: options.cwd,
    flag: commandLine.dataFolder,
  });
  mkdirSync(dataFolder, { recursive: true, mode: 0o700 });

  const identity: InstanceIdentity = {
    app: "aidm-ui",
    version: options.version,
    instance: instanceId(dataFolder),
  };

  const attach = async (port: number): Promise<StartResult> => {
    const url = urlFor(port);
    await options.openBrowser(url);
    return { kind: "attached", url };
  };

  // A copy that uses this data folder may already run, on any port of the range.
  const lock = readLock(dataFolder);
  if (lock && isProcessAlive(lock.pid)) {
    const answer = await probe(lock.port);
    if (answer?.instance === identity.instance) return attach(lock.port);
  }

  const routes = createRoutes({ identity, assets: options.assets });
  const fetch = fallbackFetch();
  const first = commandLine.port ?? DEFAULT_PORT;
  const last = Math.min(first + PORT_ATTEMPTS - 1, 65535);

  for (let port = first; port <= last; port++) {
    let server: ReturnType<typeof Bun.serve>;
    try {
      // Outside development mode Bun shares a port between listeners (SO_REUSEPORT)
      // unless told otherwise, which would hide a second copy behind the first.
      server = Bun.serve({ hostname: LOOPBACK, port, development: false, reusePort: false, routes, fetch });
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      const answer = await probe(port);
      if (answer?.instance === identity.instance) return attach(port);
      continue;
    }

    writeLock(dataFolder, { pid: process.pid, port });
    const url = urlFor(port);
    options.log(`aidm-ui is running at ${url}`);
    await options.openBrowser(url);
    return {
      kind: "started",
      url,
      port,
      dataFolder,
      async stop() {
        await server.stop(true);
        removeLock(dataFolder, process.pid);
      },
    };
  }

  return {
    kind: "failed",
    problem: `No free port from ${first} to ${last}. Close the program that uses them or pass --port.`,
  };
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
