import recordedOptions from "./fixtures/task-api-2.6.1-options.json";
import type { EngineOption } from "../shared/engine-options.ts";

// A stand-in for the engine's task API (aidm-api 2.5.0), for tests. It answers
// like the real one does, including the habit of sending errors with HTTP 200.
// Its tasks follow aidm-api 2.5.0: a test drives a task through its states
// with setTask, the way the real engine would.

export interface FakeInfo {
  version: string;
  taskQueueCount: unknown;
  totalMemory: unknown;
  availableMemory: unknown;
  cpuCores: unknown;
  maxParallelTasks: unknown;
  engineVersion: unknown;
  [field: string]: unknown;
}

/** What the real 2.5.0 image answered, recorded. */
function recordedInfo(): FakeInfo {
  return {
    version: "2.5.0",
    taskQueueCount: 0,
    totalMemory: 64895025152,
    availableMemory: 59901734912,
    cpuCores: 24,
    maxImages: null,
    maxParallelTasks: 1,
    engineVersion: "0.1.0",
    engine: "aidm",
    upstreamVersion: "NodeODX 2.4.0",
    engineUpstreamVersion: "ODX 3.8.4",
  };
}

export interface FakeTask {
  zipurl?: string;
  uuid: string;
  name: string;
  options: unknown;
  /** File names, one per upload call. */
  images: string[];
  committed: boolean;
  statusCode: unknown;
  progress: number;
  /** Milliseconds; -1 while the task initialises or after a cancel. */
  processingTime: number;
  errorMessage: string | null;
  output: string[];
  /** The bytes of all.zip, or null while it does not exist. */
  results: Uint8Array | null;
}

export const WRONG_TOKEN_MESSAGE = "Invalid authentication token: token does not match.";

export interface FakeRequest {
  method: string;
  path: string;
  token: string | null;
}

export class FakeTaskApi {
  info: FakeInfo;
  /** The API 2.6.1 test-mode option fixture, independent of the catalogue. */
  options: EngineOption[] = structuredClone(recordedOptions) as EngineOption[];
  createError: string | null = null;
  token: string;
  /** How long the info call waits before it answers. */
  infoDelayMs = 0;
  readonly requests: FakeRequest[] = [];
  readonly tasks = new Map<string, FakeTask>();
  /** One entry per upload call. */
  readonly uploads: Array<{ uuid: string; fileName: string; size: number }> = [];
  /** Called after a commit; set statusCode, processingTime and so on to start the task somewhere else than queued. */
  onCommit?: (task: FakeTask) => void;
  /** Milliseconds every upload call waits before it answers, to make uploads slow. */
  uploadDelayMs = 0;
  /** Milliseconds a cancel call waits before the engine acts on it, to make a cancel slow. */
  cancelDelayMs = 0;
  resultsWait?: Promise<void>;
  private nextUuid = 1;

  private server: Bun.Server<undefined> | undefined;
  private port = 0;
  /** The Unix socket it listens on instead of a port, like a task API started with `socket` in its config. */
  private socket: string | null = null;

  constructor(options: { token?: string; info?: Partial<FakeInfo> } = {}) {
    this.token = options.token ?? "fake-token";
    this.info = { ...recordedInfo(), ...options.info };
  }

  get address(): string {
    return this.socket === null ? `http://127.0.0.1:${this.port}` : `unix:${this.socket}`;
  }

  /** Port 0 or none picks a free one. */
  async start(port = 0): Promise<void> {
    if (this.server) throw new Error("The fake task API is already running.");
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      development: false,
      fetch: (req) => this.handle(req),
    });
    this.port = this.server.port as number;
  }

  /** Listens on a Unix socket at that path, the way Apple's tool relays the task API's socket to the Mac. */
  async startOnSocket(path: string): Promise<void> {
    if (this.server) throw new Error("The fake task API is already running.");
    this.socket = path;
    this.server = Bun.serve({ unix: path, development: false, fetch: (req) => this.handle(req) });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.stop(true);
  }

  /** Listens again on the port it had. */
  async restart(): Promise<void> {
    await this.stop();
    if (this.socket !== null) await this.startOnSocket(this.socket);
    else await this.start(this.port);
  }

  /** Changes a task the way the engine would on its own. */
  setTask(uuid: string, patch: Partial<FakeTask>): void {
    const task = this.tasks.get(uuid);
    if (!task) throw new Error(`The fake has no task ${uuid}.`);
    Object.assign(task, patch);
  }

  private activeCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.committed && (task.statusCode === 10 || task.statusCode === 20)) count++;
    }
    return count;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.requests.push({ method: req.method, path: url.pathname, token: url.searchParams.get("token") });

    const routed = this.isKnownRoute(req.method, url.pathname);
    if (routed && url.searchParams.get("token") !== this.token) return Response.json({ error: WRONG_TOKEN_MESSAGE });

    if (req.method === "GET" && url.pathname === "/info") {
      if (this.infoDelayMs > 0) await Bun.sleep(this.infoDelayMs);
      const active = this.activeCount();
      if (active === 0) return Response.json(this.info);
      const base = typeof this.info.taskQueueCount === "number" ? this.info.taskQueueCount : 0;
      return Response.json({ ...this.info, taskQueueCount: base + active });
    }
    if (req.method === "GET" && url.pathname === "/options") return Response.json(this.options);
    if (req.method === "POST" && (url.pathname === "/task/new/init" || url.pathname === "/task/new")) return this.init(req);
    if (req.method === "POST" && url.pathname === "/task/cancel") return this.command(req, "cancel");
    if (req.method === "POST" && url.pathname === "/task/remove") return this.command(req, "remove");
    if (req.method === "POST" && url.pathname === "/task/restart") {
      const form = await req.formData();
      const uuid = String(form.get("uuid"));
      const task = this.tasks.get(uuid);
      if (!task) return Response.json({ error: `${uuid} not found` });
      if (task.statusCode === 10 || task.statusCode === 20) return Response.json({ error: "Task is already running" });
      task.options = JSON.parse(String(form.get("options")));
      Object.assign(task, { statusCode: 10, progress: 0, processingTime: -1, errorMessage: null, output: [], results: null });
      this.onCommit?.(task);
      return Response.json({ success: true });
    }

    const path = url.pathname.split("/");
    if (req.method === "POST" && path.length === 5 && path[1] === "task" && path[2] === "new" && path[3] === "upload") {
      return this.upload(req, path[4] as string);
    }
    if (req.method === "POST" && path.length === 5 && path[1] === "task" && path[2] === "new" && path[3] === "commit") {
      return this.commit(path[4] as string);
    }
    if (req.method === "GET" && path.length === 4 && path[1] === "task" && path[3] === "info") {
      const task = this.tasks.get(path[2] as string);
      if (!task) return Response.json({ error: `${path[2]} not found` });
      return Response.json(this.infoOf(task));
    }
    if (req.method === "GET" && path.length === 4 && path[1] === "task" && path[3] === "output") {
      const task = this.tasks.get(path[2] as string);
      if (!task) return Response.json({ error: `${path[2]} not found` });
      const line = Number(url.searchParams.get("line") ?? "0");
      return Response.json(task.output.slice(Number.isInteger(line) && line > 0 ? line : 0));
    }
    if (req.method === "GET" && path.length === 5 && path[1] === "task" && path[3] === "download") {
      const task = this.tasks.get(path[2] as string);
      if (!task) return Response.json({ error: `${path[2]} not found` });
      if (path[4] !== "all.zip") return Response.json({ error: "Invalid asset" });
      await this.resultsWait;
      if (task.results === null) return Response.json({ error: "Asset not ready" });
      return new Response(task.results as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": "application/zip", "content-disposition": "attachment; filename=all.zip" },
      });
    }
    return new Response(`<pre>Cannot ${req.method} ${url.pathname}</pre>`, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  /** The real API checks the token on its routes only; an unknown path is a plain 404. */
  private isKnownRoute(method: string, pathname: string): boolean {
    const path = pathname.split("/");
    if (method === "GET") {
      return pathname === "/info" || pathname === "/options" || (path[1] === "task" && ((path.length === 4 && (path[3] === "info" || path[3] === "output")) || (path.length === 5 && path[3] === "download")));
    }
    if (method === "POST") {
      return (
        pathname === "/task/new" ||
        pathname === "/task/new/init" ||
        pathname === "/task/cancel" ||
        pathname === "/task/remove" ||
        pathname === "/task/restart" ||
        (path.length === 5 && path[1] === "task" && path[2] === "new" && (path[3] === "upload" || path[3] === "commit"))
      );
    }
    return false;
  }

  private infoOf(task: FakeTask): Record<string, unknown> {
    return {
      uuid: task.uuid,
      name: task.name,
      dateCreated: Date.now(),
      processingTime: task.processingTime,
      status: task.errorMessage === null ? { code: task.statusCode } : { code: task.statusCode, errorMessage: task.errorMessage },
      options: Array.isArray(task.options) ? task.options : [],
      imagesCount: task.images.length,
      progress: task.progress,
    };
  }

  private async init(req: Request): Promise<Response> {
    if (this.createError !== null) return Response.json({ error: this.createError });
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: "Malformed form body" });
    }
    let options: unknown = [];
    const rawOptions = form.get("options");
    if (typeof rawOptions === "string") {
      try {
        options = JSON.parse(rawOptions);
      } catch (error) {
        return Response.json({ error: `JSON Parse error: ${error instanceof Error ? error.message : "bad options"}` });
      }
    }
    const uuid = `00000000-0000-4000-8000-${String(this.nextUuid++).padStart(12, "0")}`;
    const name = form.get("name");
    // The real API shows RUNNING while it reads the images, with processing time -1.
    this.tasks.set(uuid, {
      uuid,
      name: typeof name === "string" ? name : "",
      options,
      images: [],
      committed: typeof form.get("zipurl") === "string",
      ...(typeof form.get("zipurl") === "string" ? { zipurl: form.get("zipurl") as string } : {}),
      statusCode: 20,
      progress: 0,
      processingTime: -1,
      errorMessage: null,
      output: [],
      results: null,
    });
    return Response.json({ uuid });
  }

  private async upload(req: Request, uuid: string): Promise<Response> {
    if (this.uploadDelayMs > 0) await Bun.sleep(this.uploadDelayMs);
    const task = this.tasks.get(uuid);
    if (!task || task.committed) return Response.json({ error: "Invalid uuid (not found)" });
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: "Upload aborted" });
    }
    const files = form.getAll("images").filter((entry): entry is File => typeof entry !== "string");
    if (files.length === 0) return Response.json({ error: "Need at least 1 file.", noRetry: true });
    // The task may have been removed while the body arrived.
    if (this.tasks.get(uuid) !== task) return Response.json({ error: "Invalid uuid (not found)" });
    for (const file of files) {
      task.images.push(file.name);
      this.uploads.push({ uuid, fileName: file.name, size: file.size });
    }
    return Response.json({ success: true });
  }

  private commit(uuid: string): Response {
    const task = this.tasks.get(uuid);
    if (!task || task.committed) return Response.json({ error: "Invalid uuid (not found)" });
    if (task.images.length === 0) return Response.json({ error: "Need at least 1 file." });
    task.committed = true;
    task.statusCode = 10;
    task.processingTime = -1;
    this.onCommit?.(task);
    return Response.json({ uuid });
  }

  private async command(req: Request, what: "cancel" | "remove"): Promise<Response> {
    let uuid: unknown;
    try {
      if ((req.headers.get("content-type") ?? "").includes("json")) {
        uuid = ((await req.json()) as { uuid?: unknown }).uuid;
      } else {
        uuid = (await req.formData()).get("uuid");
      }
    } catch {
      return Response.json({ error: "JSON Parse error: Unexpected EOF" });
    }
    if (typeof uuid !== "string" || uuid === "") return Response.json({ error: "uuid param missing." });
    if (what === "cancel" && this.cancelDelayMs > 0) await Bun.sleep(this.cancelDelayMs);
    const task = this.tasks.get(uuid);
    if (!task) return Response.json({ success: false, error: `${uuid} not found` });
    if (what === "cancel") {
      task.statusCode = 50;
      task.processingTime = -1;
    } else {
      this.tasks.delete(uuid);
    }
    return Response.json({ success: true });
  }
}
