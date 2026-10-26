// A stand-in for the engine's task API (aidm-api 2.5.0), for tests. It answers
// like the real one does, including the habit of sending errors with HTTP 200.
// Later tickets add tasks to it.

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

export const WRONG_TOKEN_MESSAGE = "Invalid authentication token: token does not match.";

export interface FakeRequest {
  method: string;
  path: string;
  token: string | null;
}

export class FakeTaskApi {
  info: FakeInfo;
  token: string;
  /** How long the info call waits before it answers. */
  infoDelayMs = 0;
  readonly requests: FakeRequest[] = [];

  private server: Bun.Server<undefined> | undefined;
  private port = 0;

  constructor(options: { token?: string; info?: Partial<FakeInfo> } = {}) {
    this.token = options.token ?? "fake-token";
    this.info = { ...recordedInfo(), ...options.info };
  }

  get address(): string {
    return `http://127.0.0.1:${this.port}`;
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

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.stop(true);
  }

  /** Listens again on the port it had. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start(this.port);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.requests.push({ method: req.method, path: url.pathname, token: url.searchParams.get("token") });

    if (req.method === "GET" && url.pathname === "/info") {
      if (this.infoDelayMs > 0) await Bun.sleep(this.infoDelayMs);
      if (url.searchParams.get("token") !== this.token) return Response.json({ error: WRONG_TOKEN_MESSAGE });
      return Response.json(this.info);
    }
    return new Response(`<pre>Cannot ${req.method} ${url.pathname}</pre>`, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}
