// A stand-in for a container registry, for tests. It is mounted on the fake
// file server. It asks for tokens, answers blob requests with a 307 to a
// short-lived signed address, supports byte ranges, and can cut, stall or
// corrupt a blob body.

export interface FakeImage {
  /** The repository path in the registry, e.g. "aidronemap/aidm-api". */
  repository: string;
  config: Uint8Array;
  layers: Uint8Array[];
}

export interface AddedImage {
  /** The manifest digest, "sha256:<hex>". */
  digest: string;
  manifest: Uint8Array;
  configDigest: string;
  layerDigests: string[];
  /** Config plus layers, the bytes a download takes. */
  size: number;
}

export interface FakeRegistryRequest {
  method: string;
  path: string;
  range: string | null;
  authorization: string | null;
  at: number;
}

const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
const CONFIG_TYPE = "application/vnd.oci.image.config.v1+json";
const LAYER_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip";
const SERVICE = "fake-registry";
const CHUNK_SIZE = 16 * 1024;

interface StoredManifest {
  bytes: Uint8Array<ArrayBuffer>;
  mediaType: string;
}

interface Failure {
  status: number;
  count: number;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorBody(code: string): { errors: { code: string }[] } {
  return { errors: [{ code }] };
}

export class FakeRegistry {
  readonly requests: FakeRegistryRequest[] = [];
  /** Tokens older than this are refused with 401. */
  tokenLifetimeMs = Infinity;
  /** How long a signed blob address works after the redirect that made it. */
  signedAddressLifetimeMs = 60_000;
  /** When set, every blob body is cut once its response has been streaming this many milliseconds (real time), like a path that resets long connections. */
  resetEveryMs: number | null = null;
  /** When set, blob bodies are paced to about this many bytes per second (real time), in chunks of at most 16 KiB. */
  bytesPerSecond: number | null = null;

  private readonly now: () => number;
  private readonly manifests = new Map<string, Map<string, StoredManifest>>();
  private readonly blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  private readonly tokens = new Map<string, number>();
  private readonly redirectCounts = new Map<string, number>();
  private readonly failures = new Map<string, Failure>();
  private readonly stalls = new Map<string, number>();
  private readonly corruptions = new Set<string>();
  private tokenCount = 0;
  private signatureCount = 0;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  addImage(image: FakeImage): AddedImage {
    const config = new Uint8Array(image.config);
    const layers = image.layers.map((layer) => new Uint8Array(layer));
    const configDigest = sha256(config);
    this.blobs.set(configDigest, config);
    const layerDigests = layers.map((layer) => {
      const digest = sha256(layer);
      this.blobs.set(digest, layer);
      return digest;
    });

    const manifest = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: MANIFEST_TYPE,
        config: { mediaType: CONFIG_TYPE, digest: configDigest, size: config.length },
        layers: layers.map((layer, index) => ({
          mediaType: LAYER_TYPE,
          digest: layerDigests[index],
          size: layer.length,
        })),
      }),
    );
    const digest = sha256(manifest);
    let forRepository = this.manifests.get(image.repository);
    if (forRepository === undefined) {
      forRepository = new Map();
      this.manifests.set(image.repository, forRepository);
    }
    forRepository.set(digest, { bytes: manifest, mediaType: MANIFEST_TYPE });

    const size = layers.reduce((total, layer) => total + layer.length, config.length);
    return { digest, manifest, configDigest, layerDigests, size };
  }

  /** Serves manifest bytes as they are, for a manifest addImage would not make (an index, an old schema). Returns its digest. */
  addManifest(repository: string, bytes: Uint8Array, mediaType: string): string {
    const digest = sha256(bytes);
    let forRepository = this.manifests.get(repository);
    if (forRepository === undefined) {
      forRepository = new Map();
      this.manifests.set(repository, forRepository);
    }
    forRepository.set(digest, { bytes: new Uint8Array(bytes), mediaType });
    return digest;
  }

  /** The next response for this blob sends `afterBytes` bytes and then nothing, with the connection left open. */
  stallNext(digest: string, afterBytes: number): void {
    this.stalls.set(digest, afterBytes);
  }

  /** The next response for this blob that starts at byte 0 has one byte flipped, so its checksum fails. */
  corruptNext(digest: string): void {
    this.corruptions.add(digest);
  }

  /** The next `count` requests for this blob's registry address answer with `status` (e.g. 503) and no body. */
  failNext(digest: string, status: number, count = 1): void {
    this.failures.set(digest, { status, count });
  }

  /** How many tokens have been handed out. */
  tokensIssued(): number {
    return this.tokenCount;
  }

  /** How many times the registry address of this blob has answered with a redirect. */
  redirects(digest: string): number {
    return this.redirectCounts.get(digest) ?? 0;
  }

  handles(path: string): boolean {
    return path === "/token" || path.startsWith("/v2/") || path.startsWith("/signed/");
  }

  answer(request: Request, url: (path: string) => string): Response | Promise<Response> {
    const address = new URL(request.url);
    const path = address.pathname;
    const authorization = request.headers.get("authorization");
    this.requests.push({
      method: request.method,
      path,
      range: request.headers.get("range"),
      authorization,
      at: this.now(),
    });

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (path === "/token") return this.issueToken(address);
    if (path === "/v2/") {
      const challenge = `Bearer realm="${url("/token")}",service="${SERVICE}"`;
      return json(401, errorBody("UNAUTHORIZED"), { "www-authenticate": challenge });
    }
    if (path.startsWith("/signed/")) return this.answerSigned(request, address);

    const match = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(path);
    if (match === null) return json(404, errorBody("NAME_UNKNOWN"));
    const repository = decodeURIComponent(match[1] ?? "");
    const kind = match[2];
    const digest = decodeURIComponent(match[3] ?? "");

    if (!this.tokenIsValid(authorization)) {
      const challenge = `Bearer realm="${url("/token")}",service="${SERVICE}",scope="repository:${repository}:pull"`;
      return json(401, errorBody("UNAUTHORIZED"), { "www-authenticate": challenge });
    }
    if (kind === "manifests") return this.answerManifest(request, repository, digest);
    return this.answerBlob(digest, url);
  }

  private issueToken(address: URL): Response {
    const scope = address.searchParams.get("scope") ?? "";
    const match = /^repository:(.+):pull$/.exec(scope);
    const repository = match?.[1];
    if (repository === undefined || !this.manifests.has(repository)) {
      return json(401, errorBody("DENIED"));
    }
    this.tokenCount += 1;
    const token = `tok-${this.tokenCount}`;
    this.tokens.set(token, this.now());
    return json(200, { token, access_token: token, expires_in: 300 });
  }

  private tokenIsValid(authorization: string | null): boolean {
    const match = /^Bearer (.+)$/.exec(authorization ?? "");
    const issuedAt = this.tokens.get(match?.[1] ?? "");
    if (issuedAt === undefined) return false;
    return this.now() - issuedAt <= this.tokenLifetimeMs;
  }

  private answerManifest(request: Request, repository: string, digest: string): Response {
    const manifest = this.manifests.get(repository)?.get(digest);
    if (manifest === undefined) return json(404, errorBody("MANIFEST_UNKNOWN"));
    const headers = {
      "content-type": manifest.mediaType,
      "docker-content-digest": digest,
      "content-length": String(manifest.bytes.length),
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(manifest.bytes, { status: 200, headers });
  }

  private answerBlob(digest: string, url: (path: string) => string): Response {
    const failure = this.failures.get(digest);
    if (failure !== undefined && failure.count > 0) {
      failure.count -= 1;
      return new Response(null, { status: failure.status });
    }
    if (!this.blobs.has(digest)) return json(404, errorBody("BLOB_UNKNOWN"));

    this.redirectCounts.set(digest, this.redirects(digest) + 1);
    this.signatureCount += 1;
    const expires = this.now() + this.signedAddressLifetimeMs;
    const hex = digest.slice("sha256:".length);
    const location = `${url(`/signed/${hex}`)}?se=${expires}&sig=${this.signatureCount}`;
    return new Response(null, { status: 307, headers: { location } });
  }

  private answerSigned(request: Request, address: URL): Response {
    // A storage host refuses a second credential next to the signed address.
    if (request.headers.has("authorization")) {
      return new Response("<Error><Code>InvalidAuthenticationInfo</Code></Error>", {
        status: 400,
        headers: { "content-type": "application/xml" },
      });
    }
    const expires = Number(address.searchParams.get("se"));
    if (!(this.now() <= expires)) {
      return new Response("<Error><Code>AuthenticationFailed</Code></Error>", {
        status: 403,
        headers: { "content-type": "application/xml" },
      });
    }
    const digest = `sha256:${address.pathname.slice("/signed/".length)}`;
    const blob = this.blobs.get(digest);
    if (blob === undefined) return new Response("Not found", { status: 404 });

    const range = request.headers.get("range");
    let start = 0;
    let end = blob.length - 1;
    let partial = false;
    if (range !== null) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(Number(match[2]), blob.length - 1);
        if (start >= blob.length) {
          return new Response(null, {
            status: 416,
            headers: { "content-range": `bytes */${blob.length}` },
          });
        }
        partial = true;
      }
    }

    let body = blob.subarray(start, end + 1);
    const headers: Record<string, string> = {
      "content-length": String(body.length),
      "accept-ranges": "bytes",
      "content-type": "application/octet-stream",
    };
    if (partial) headers["content-range"] = `bytes ${start}-${end}/${blob.length}`;
    const status = partial ? 206 : 200;

    if (request.method === "HEAD") return new Response(null, { status, headers });

    if (start === 0 && body.length > 0 && this.corruptions.delete(digest)) {
      body = new Uint8Array(body);
      body[0] = (body[0] ?? 0) ^ 0xff;
    }
    const stallAfter = this.stalls.get(digest);
    this.stalls.delete(digest);
    return new Response(this.stream(body, stallAfter), { status, headers });
  }

  /** Sends the body in small chunks, paced and cut as the settings ask. */
  private stream(body: Uint8Array<ArrayBuffer>, stallAfter: number | undefined): ReadableStream<Uint8Array> {
    const startedAt = Date.now();
    const resetEveryMs = this.resetEveryMs;
    const bytesPerSecond = this.bytesPerSecond;
    const limit = stallAfter === undefined ? body.length : Math.min(stallAfter, body.length);
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent >= limit) {
          if (stallAfter !== undefined && limit < body.length) {
            // Never answers, so the body neither ends nor breaks until the client gives up.
            await new Promise<void>(() => {});
          }
          controller.close();
          return;
        }
        if (resetEveryMs !== null && Date.now() - startedAt >= resetEveryMs) {
          // Erroring at once would drop the bytes still waiting to be sent.
          await Bun.sleep(30);
          controller.error(new Error("The fake registry reset the connection."));
          return;
        }
        const chunk = body.subarray(sent, Math.min(sent + CHUNK_SIZE, limit));
        sent += chunk.length;
        controller.enqueue(chunk);
        if (bytesPerSecond !== null && sent < limit) {
          await Bun.sleep((chunk.length / bytesPerSecond) * 1000);
        }
      },
    });
  }
}
