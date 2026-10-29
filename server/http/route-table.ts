import type { ImportStore } from "../projects/import-store.ts";
import { errorResponse } from "../../shared/api-error.ts";
import { MAX_REQUEST_BODY_BYTES } from "./limits.ts";
import type { ProjectStore } from "../projects/project-store.ts";
import type { ProjectDeletion } from "../projects/project-deletion.ts";
import type { PhotoStore } from "../photos/photo-store.ts";
import type { UploadStore } from "../projects/upload-store.ts";
import type { AuthHook, ClientInfo } from "../auth/hook.ts";
import type { Sessions } from "../auth/sessions.ts";
import type { InstanceIdentity } from "../app/instance.ts";
import type { EngineMonitor } from "../engines/engine-monitor.ts";
import type { EngineStore } from "../engines/engine-store.ts";
import type { LocalEngineManager } from "../local-engine/manager.ts";
import type { RuntimeSetup } from "../runtimes/podman-setup.ts";
import type { RunTracker } from "../runs/run-tracker.ts";
import type { SampleJob } from "../sample/sample-job.ts";
import type { MachineFacts } from "../machine/facts.ts";
import type { MachineChecks } from "../machine/machine-checks.ts";
import type { ManifestService } from "../manifest/manifest-service.ts";
import type { Settings } from "../settings/settings.ts";
import type { EventStreams } from "./event-streams.ts";
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
  projects: ProjectStore;
  projectDeletion: ProjectDeletion;
  uploads: UploadStore;
  photos: PhotoStore;
  imports: ImportStore;
  assets: AssetMap;
  settings: Settings;
  sessions: Sessions;
  engines: EngineMonitor;
  engineStore: EngineStore;
  /** Installs, starts and watches the engine on this computer. */
  localEngine: LocalEngineManager;
  /** Where every server-sent event stream is opened. */
  streams: EventStreams;
  tracker: RunTracker;
  sample: SampleJob;
  /** The held manifest and the engine package it offers. */
  manifests: ManifestService;
  /** Reads the computer the machine check decides by. */
  machine: { gather(): Promise<MachineFacts> };
  /** The machine check: reads the computer and keeps the last answer for a minute. */
  machineChecks: MachineChecks;
  /** The step that installs Podman where no container tool works. */
  runtimeSetup: RuntimeSetup;
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

const bodyLimits = new WeakMap<RouteHandler, number>();

/**
 * A handler that may be sent a body larger than the small JSON every other
 * route reads. The guard refuses a request to any other handler whose body is
 * over MAX_REQUEST_BODY_BYTES. The limit must not be above MAX_RAISED_BODY_BYTES,
 * the ceiling the listener gives Bun.
 */
export function withBodyLimit(limit: number, handler: RouteHandler): RouteHandler {
  bodyLimits.set(handler, limit);
  return handler;
}

/** The most bytes a request to this handler may carry. */
export function bodyLimitOf(handler: RouteHandler): number {
  return bodyLimits.get(handler) ?? MAX_REQUEST_BODY_BYTES;
}

export type JsonBody = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

/** The body as text, or null when it is over the limit. A body without a declared length is cut off at the limit as it is read. */
async function readCapped(req: Request, limit: number): Promise<string | null> {
  if (req.body === null) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req.body) {
    total += chunk.byteLength;
    if (total > limit) return null;
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Reads a request body that must be a JSON object. Anything else is a coded 400, and a body over 1 MiB a coded 413. */
export async function readJson(req: Request): Promise<JsonBody> {
  try {
    const text = await readCapped(req, MAX_REQUEST_BODY_BYTES);
    if (text === null) return { ok: false, response: errorResponse(413, "api.body_too_large") };
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return { ok: true, body: body as Record<string, unknown> };
    }
  } catch {
    // Not JSON, or the connection broke while reading.
  }
  return { ok: false, response: errorResponse(400, "api.invalid_body") };
}
