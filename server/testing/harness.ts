import { Database } from "bun:sqlite";
import os from "node:os";
import { currentAuth } from "../auth/current.ts";
import { Sessions } from "../auth/sessions.ts";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { EngineMonitor } from "../engines/engine-monitor.ts";
import { EngineStore } from "../engines/engine-store.ts";
import { listen, LOOPBACK, type Listener } from "../http/listener.ts";
import { createRoutes, fallbackFetch } from "../http/routes.ts";
import type { RouteContext } from "../http/route-table.ts";
import type { AssetMap } from "../http/static-assets.ts";
import { Settings } from "../settings/settings.ts";

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
  } = {},
): Harness {
  const db = new Database(":memory:", { strict: true });
  applyMigrations(db, migrations);
  const settings = new Settings(db);
  const sessions = new Sessions();
  const clock = { now: Date.now() };
  const logs: string[] = [];
  const rebinds: string[] = [];
  let listener: Listener | undefined;
  const log = (line: string) => logs.push(line);
  const engineStore = new EngineStore(db);
  const engines = new EngineMonitor({ store: engineStore, intervalMs: options.enginePollMs ?? 100, log });

  const ctx: RouteContext = {
    identity: TEST_IDENTITY,
    assets: options.assets ?? new Map(),
    settings,
    sessions,
    engines,
    engineStore,
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

  return {
    base: `http://${LOOPBACK}:${listener.port}`,
    port: listener.port,
    ctx,
    settings,
    sessions,
    engines,
    engineStore,
    clock,
    logs,
    rebinds,
    async stop() {
      await engines.stop();
      await listener?.stop();
      db.close();
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
