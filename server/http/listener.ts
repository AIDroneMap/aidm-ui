import type { Method } from "./route-table.ts";

export const ALL_INTERFACES = "0.0.0.0";
export const LOOPBACK = "127.0.0.1";

/** What Bun.serve takes as routes: every handler already wrapped by the guard. */
export type ServeRoutes = Record<string, GuardedHandler | Partial<Record<Method, GuardedHandler>>>;
export type GuardedHandler = (req: Bun.BunRequest, server: Bun.Server<undefined>) => Promise<Response>;

export interface Listener {
  readonly port: number;
  readonly hostname: string;
  /** Stops the current server and listens on the same port at the new address. */
  rebind(hostname: string): Promise<void>;
  stop(): Promise<void>;
}

export interface ListenOptions {
  hostname: string;
  port: number;
  routes: ServeRoutes;
  fetch: (req: Request) => Response;
}

/** Throws Bun's EADDRINUSE error when the port is taken. */
export function listen(options: ListenOptions): Listener {
  const { routes, fetch } = options;
  const serve = (hostname: string, port: number) =>
    // Outside development mode Bun shares a port between listeners (SO_REUSEPORT)
    // unless told otherwise, which would hide a second copy behind the first.
    // The idle timeout is short because only a few routes stream; those switch it off for their requests.
    Bun.serve({ hostname, port, development: false, reusePort: false, idleTimeout: 30, routes, fetch });

  let server: Bun.Server<undefined> | undefined = serve(options.hostname, options.port);
  let hostname = options.hostname;
  const port = server.port as number;
  // Rebinds and the final stop run one after the other.
  let queue: Promise<unknown> = Promise.resolve();
  let stopped = false;
  const inTurn = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };

  return {
    port,
    get hostname() {
      return hostname;
    },
    rebind(next) {
      return inTurn(async () => {
        if (stopped || next === hostname) return;
        await server?.stop(true);
        server = undefined;
        try {
          server = serve(next, port);
          hostname = next;
        } catch (error) {
          // Go back to what worked, so the operator is not left without a server.
          server = serve(hostname, port);
          throw error;
        }
      });
    },
    stop() {
      stopped = true;
      return inTurn(async () => {
        await server?.stop(true);
        server = undefined;
      });
    },
  };
}
