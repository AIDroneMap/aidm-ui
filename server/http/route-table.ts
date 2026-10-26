import { errorResponse } from "../../shared/api-error.ts";
import type { AuthHook, ClientInfo } from "../auth/hook.ts";
import type { Sessions } from "../auth/sessions.ts";
import type { InstanceIdentity } from "../app/instance.ts";
import type { EngineMonitor } from "../engines/engine-monitor.ts";
import type { EngineStore } from "../engines/engine-store.ts";
import type { Settings } from "../settings/settings.ts";
import type { AssetMap } from "./static-assets.ts";

export interface RequestContext {
  client: ClientInfo;
  /** For the few routes that stream and must switch off the idle timeout. */
  server: Bun.Server<undefined>;
}

export type RouteHandler = (req: Bun.BunRequest, rc: RequestContext) => Response | Promise<Response>;
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** Path (Bun route syntax, ":id" for parameters) to a handler per method. */
export type RouteTable = Record<string, Partial<Record<Method, RouteHandler>>>;

/** Everything the routes need from the rest of the server. */
export interface RouteContext {
  identity: InstanceIdentity;
  assets: AssetMap;
  settings: Settings;
  sessions: Sessions;
  engines: EngineMonitor;
  engineStore: EngineStore;
  /** A function because the hook changes when the LAN switch moves. */
  auth: () => AuthHook;
  /** The port the server listens on now. */
  listeningPort: () => number;
  /** Moves the listener to another interface. Resolves when it listens again. */
  rebind: (hostname: string) => Promise<void>;
  now: () => number;
  /** The server log. Error details go here and never into a response. */
  log: (line: string) => void;
}

export type JsonBody = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

/** Reads a request body that must be a JSON object. Anything else is a coded 400. */
export async function readJson(req: Request): Promise<JsonBody> {
  try {
    const body: unknown = await req.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return { ok: true, body: body as Record<string, unknown> };
    }
  } catch {
    // Not JSON, or the connection broke while reading.
  }
  return { ok: false, response: errorResponse(400, "api.invalid_body") };
}
