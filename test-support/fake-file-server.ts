// A stand-in for a file host (Hugging Face now, GitHub Releases in a later
// ticket), for tests. It supports byte ranges, redirects, and cutting a
// response in the middle of the body.

export interface FakeFileRequest {
  method: string;
  path: string;
  range: string | null;
}

export class FakeFileServer {
  files: Map<string, Uint8Array>;
  redirects = new Map<string, string>();
  readonly requests: FakeFileRequest[] = [];

  private server: Bun.Server<undefined> | undefined;
  private port = 0;
  private cutAfter: number | undefined;
  private stallAfter: number | undefined;

  constructor(files: Record<string, Uint8Array> = {}) {
    this.files = new Map(Object.entries(files));
  }

  /** Port 0 or none picks a free one. */
  async start(port = 0): Promise<void> {
    if (this.server) throw new Error("The fake file server is already running.");
    this.server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: (request) => this.answer(request),
    });
    this.port = this.server.port ?? port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.stop(true);
  }

  /** Stops and starts again on the same port. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start(this.port);
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  /** The next GET of a file sends only this many bytes of the body and then breaks the connection. */
  cutNextResponseAfter(bytes: number): void {
    this.cutAfter = bytes;
  }

  /** The next GET of a file sends only this many bytes of the body and then goes quiet, with the connection open. */
  stallNextResponseAfter(bytes: number): void {
    this.stallAfter = bytes;
  }

  private answer(request: Request): Response {
    const path = new URL(request.url).pathname;
    const range = request.headers.get("range");
    this.requests.push({ method: request.method, path, range });

    const target = this.redirects.get(path);
    if (target !== undefined) {
      return new Response(null, { status: 302, headers: { location: this.url(target) } });
    }
    const file = this.files.get(path);
    if (file === undefined) return new Response("Not found", { status: 404 });

    let start = 0;
    let end = file.length - 1;
    let partial = false;
    if (range !== null) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(Number(match[2]), file.length - 1);
        if (start >= file.length) {
          return new Response(null, {
            status: 416,
            headers: { "content-range": `bytes */${file.length}` },
          });
        }
        partial = true;
      }
    }

    const body = file.subarray(start, end + 1) as Uint8Array<ArrayBuffer>;
    const headers: Record<string, string> = {
      "content-length": String(body.length),
      "accept-ranges": "bytes",
    };
    if (partial) headers["content-range"] = `bytes ${start}-${end}/${file.length}`;
    const status = partial ? 206 : 200;

    if (request.method === "HEAD") return new Response(null, { status, headers });

    if (this.cutAfter !== undefined) {
      const cut = Math.min(this.cutAfter, body.length);
      this.cutAfter = undefined;
      // The stream sends the first bytes and then errors, so Bun resets the
      // connection before the declared Content-Length is reached.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.subarray(0, cut));
        },
        async pull(controller) {
          // Erroring at once would drop the bytes still waiting to be sent.
          await Bun.sleep(30);
          controller.error(new Error("The fake file server cut the response."));
        },
      });
      return new Response(stream, { status, headers });
    }
    if (this.stallAfter !== undefined) {
      const first = body.subarray(0, Math.min(this.stallAfter, body.length));
      this.stallAfter = undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
        },
        // Never answers, so the body neither ends nor breaks until the client gives up.
        pull: () => new Promise<void>(() => {}),
      });
      return new Response(stream, { status, headers });
    }
    return new Response(body, { status, headers });
  }
}
