import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeRegistry, type AddedImage } from "../../test-support/fake-registry.ts";
import { sizeOf } from "../downloads/downloader.ts";
import {
  blobPath,
  downloadImage,
  localName,
  type ImageDownloadOptions,
  type ImageDownloadProgress,
  type PinnedImage,
} from "./image-download.ts";

const REPOSITORY_PATH = "aidronemap/aidm-api";
const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
// Short times everywhere, so a test that goes wrong fails quickly.
const QUICK = { backoffMs: () => 10, idleMs: 1000, stallMs: 5000 };

/** Deterministic bytes that differ from one seed to the next. */
function bytesOf(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + (i >> 8) * seed + seed) & 0xff);
}

const config = bytesOf(2048, 1);
const layers = [bytesOf(200 * 1024, 2), bytesOf(300 * 1024, 3), bytesOf(150 * 1024, 4)];

/** Wraps a function so it can stand in for fetch. */
function asFetch(fn: (input: Request | URL | string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(fn, { preconnect: fetch.preconnect }) as typeof fetch;
}

/** One request to a signed storage address, as the client sent it. */
interface SignedCall {
  hex: string;
  range: string | null;
  authorization: string | null;
  /** The bytes of the part file when the request went out: where the range should start. */
  partSize: number;
  /** Zero when the request threw. */
  status: number;
}

interface Hooks {
  /** Runs before each request goes out. */
  before?: (url: URL) => void;
  /** Runs after each answer. It may return another answer in its place. */
  after?: (url: URL, response: Response) => Promise<Response | void> | Response | void;
}

let root = "";
let folder = "";
let server: FakeFileServer;
let registry: FakeRegistry;
let added: AddedImage;
let pinned: PinnedImage;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "aidm-image-download-"));
  // The folder does not exist yet: a download that fails early must not create it.
  folder = join(root, "image");
  server = new FakeFileServer();
  registry = new FakeRegistry();
  server.registry = registry;
  await server.start();
  added = registry.addImage({ repository: REPOSITORY_PATH, config, layers });
  pinned = { repository: `${new URL(server.url("")).host}/${REPOSITORY_PATH}`, digest: added.digest };
});
afterEach(async () => {
  await server.stop();
  rmSync(root, { recursive: true, force: true });
});

/** A fetch that records every request to a signed address and lets a test step in. */
function watching(hooks: Hooks = {}): { fetch: typeof fetch; signed: SignedCall[] } {
  const signed: SignedCall[] = [];
  const watched = asFetch(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const hex = /^\/signed\/([0-9a-f]{64})$/.exec(url.pathname)?.[1];
    hooks.before?.(url);
    let call: SignedCall | undefined;
    if (hex !== undefined) {
      call = {
        hex,
        range: headers.get("range"),
        authorization: headers.get("authorization"),
        partSize: sizeOf(`${blobPath(folder, `sha256:${hex}`)}.part`),
        status: 0,
      };
      signed.push(call);
    }
    let response = await fetch(input, init);
    if (call !== undefined) call.status = response.status;
    const replaced = await hooks.after?.(url, response);
    if (replaced instanceof Response) response = replaced;
    return response;
  });
  return { fetch: watched, signed };
}

function hexOf(digest: string): string {
  return digest.slice("sha256:".length);
}

function sha256Of(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

function allDigests(): string[] {
  return [added.configDigest, ...added.layerDigests];
}

function partOf(digest: string): string {
  return `${blobPath(folder, digest)}.part`;
}

/** Every blob file is there and hashes to its digest, and no part file is left. */
function expectBlobsVerified(): void {
  for (const digest of [added.digest, ...allDigests()]) {
    expect(sha256Of(blobPath(folder, digest))).toBe(hexOf(digest));
  }
  for (const digest of allDigests()) expect(existsSync(partOf(digest))).toBe(false);
}

function download(options: ImageDownloadOptions = {}, image: PinnedImage = pinned) {
  return downloadImage(image, folder, { ...QUICK, ...options });
}

function pathOf(request: { path: string }): string {
  return decodeURIComponent(request.path);
}

/** Puts raw manifest bytes in the fake registry, which only builds image manifests itself. */
function addRawManifest(bytes: Uint8Array, mediaType: string): PinnedImage {
  return { ...pinned, digest: registry.addManifest(REPOSITORY_PATH, bytes, mediaType) };
}

test("downloads the manifest, the config and the layers as separate requests, verifies them and writes an OCI layout", async () => {
  const progress: ImageDownloadProgress[] = [];
  const outcome = await download({ onProgress: (p) => progress.push(p) });
  if (!outcome.ok) throw new Error(`The download failed: ${outcome.error.code}`);

  const image = outcome.image;
  expect(image.pinned).toEqual(pinned);
  expect(image.folder).toBe(folder);
  expect(image.name).toBe(localName(pinned));
  expect(image.manifest).toEqual({ digest: added.digest, size: added.manifest.length, mediaType: MANIFEST_TYPE });
  expect(image.config).toEqual({ digest: added.configDigest, size: config.length });
  expect(image.layers).toEqual(added.layerDigests.map((digest, i) => ({ digest, size: layers[i]?.length ?? -1 })));
  expectBlobsVerified();

  // One manifest GET with a token, then one registry request and one signed GET per blob.
  const manifestGets = registry.requests.filter((r) => pathOf(r).includes("/manifests/") && r.authorization !== null);
  expect(manifestGets).toHaveLength(1);
  const blobRequests = registry.requests.filter((r) => pathOf(r).includes("/blobs/"));
  expect(blobRequests.map(pathOf)).toEqual(allDigests().map((d) => `/v2/${REPOSITORY_PATH}/blobs/${d}`));
  expect(blobRequests.every((r) => r.authorization !== null)).toBe(true);
  for (const digest of allDigests()) expect(registry.redirects(digest)).toBe(1);
  const signed = registry.requests.filter((r) => r.path.startsWith("/signed/"));
  expect(signed.map((r) => r.path)).toEqual(allDigests().map((d) => `/signed/${hexOf(d)}`));
  expect(signed.every((r) => r.authorization === null && r.range === null)).toBe(true);

  // The layout names the manifest the two ways the runtimes read.
  expect(JSON.parse(readFileSync(join(folder, "oci-layout"), "utf8"))).toEqual({ imageLayoutVersion: "1.0.0" });
  const index = JSON.parse(readFileSync(join(folder, "index.json"), "utf8"));
  expect(index.manifests).toEqual([
    {
      mediaType: MANIFEST_TYPE,
      digest: added.digest,
      size: added.manifest.length,
      annotations: {
        "io.containerd.image.name": localName(pinned),
        "org.opencontainers.image.ref.name": `sha256-${hexOf(added.digest)}`,
      },
    },
  ]);

  // Progress runs up to the whole image.
  const received = progress.map((p) => p.received);
  expect(received).toEqual([...received].sort((a, b) => a - b));
  expect(progress[0]?.received).toBe(0);
  expect(progress.at(-1)).toMatchObject({
    received: added.size,
    total: added.size,
    blobsDone: 4,
    blobsTotal: 4,
    retries: 0,
    lastRetry: null,
  });
});

test("a download whose connection is reset every 30 seconds completes and verifies", async () => {
  // The times run at a hundredth of the real ones: a reset every 300 ms stands
  // for one every 30 s, and a layer takes seconds where a real one takes minutes.
  registry.resetEveryMs = 300;
  registry.bytesPerSecond = 200_000;
  const biggest = added.layerDigests[1] ?? "";
  const { fetch: watched, signed } = watching();
  const progress: ImageDownloadProgress[] = [];

  const outcome = await download({ fetch: watched, onProgress: (p) => progress.push(p) });
  expect(outcome.ok).toBe(true);
  expectBlobsVerified();

  const last = progress.at(-1);
  expect(last?.retries).toBeGreaterThan(0);
  expect(last?.lastRetry?.code).toBe("download.connection_interrupted");

  // Each new signed GET of the biggest layer starts where the last one stopped.
  const calls = signed.filter((c) => c.hex === hexOf(biggest));
  expect(calls.length).toBeGreaterThanOrEqual(3);
  expect(calls[0]?.range).toBeNull();
  for (const call of calls.slice(1)) {
    expect(call.partSize).toBeGreaterThan(0);
    expect(call.range).toBe(`bytes=${call.partSize}-`);
  }
  const starts = calls.map((c) => c.partSize);
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
  expect(new Set(starts).size).toBe(starts.length);
}, 30_000);

test("an aidm-ui restart in the middle continues from the bytes on disk", async () => {
  registry.bytesPerSecond = 200_000;
  const [first = "", second = "", third = ""] = added.layerDigests;
  const controller = new AbortController();
  const stopped = await download({
    signal: controller.signal,
    onProgress: () => {
      if (sizeOf(partOf(first)) >= 40_000) controller.abort();
    },
  });
  expect(stopped).toEqual({ ok: false, error: { code: "download.cancelled", data: {} } });
  const kept = sizeOf(partOf(first));
  expect(kept).toBeGreaterThanOrEqual(40_000);
  expect(kept).toBeLessThan(layers[0]?.length ?? 0);
  // The config was finished before the stop.
  expect(sha256Of(blobPath(folder, added.configDigest))).toBe(hexOf(added.configDigest));

  // The restart: a new call, a new controller, the same folder.
  registry.bytesPerSecond = null;
  const before = registry.requests.length;
  const { fetch: watched, signed } = watching();
  const again = await download({ fetch: watched });
  expect(again.ok).toBe(true);
  expectBlobsVerified();

  const asked = registry.requests.slice(before).map(pathOf);
  expect(asked.some((path) => path.includes("/manifests/"))).toBe(false);
  expect(asked.some((path) => path.includes(hexOf(added.configDigest)))).toBe(false);
  expect(signed.map((c) => [c.hex, c.range])).toEqual([
    [hexOf(first), `bytes=${kept}-`],
    [hexOf(second), null],
    [hexOf(third), null],
  ]);
  expect(registry.redirects(added.configDigest)).toBe(1);
  expect(registry.redirects(first)).toBe(2);
  expect(registry.redirects(second)).toBe(1);
  expect(registry.redirects(third)).toBe(1);
}, 30_000);

test("an expired signed address is fetched again", async () => {
  // Each try is cut after about 50 ms, and the next one waits 100 ms: by then
  // the address of the old try has expired, so only a fresh one can work.
  registry.signedAddressLifetimeMs = 50;
  registry.resetEveryMs = 50;
  registry.bytesPerSecond = 1_000_000;
  const biggest = added.layerDigests[1] ?? "";
  const { fetch: watched, signed } = watching();

  const outcome = await download({ fetch: watched, backoffMs: () => 100 });
  expect(outcome.ok).toBe(true);
  expectBlobsVerified();
  expect(registry.redirects(biggest)).toBeGreaterThan(1);
  expect(signed.length).toBeGreaterThan(4);
  expect(signed.filter((c) => c.status === 403)).toEqual([]);
  expect(signed.every((c) => c.status === 200 || c.status === 206)).toBe(true);
}, 30_000);

test("a corrupted blob is discarded alone", async () => {
  const [first = "", second = "", third = ""] = added.layerDigests;
  registry.corruptNext(second);
  const progress: ImageDownloadProgress[] = [];
  const outcome = await download({ onProgress: (p) => progress.push(p) });
  expect(outcome.ok).toBe(true);
  expectBlobsVerified();
  expect(registry.redirects(second)).toBe(2);
  expect(registry.redirects(added.configDigest)).toBe(1);
  expect(registry.redirects(first)).toBe(1);
  expect(registry.redirects(third)).toBe(1);
  expect(progress.at(-1)).toMatchObject({ retries: 1, lastRetry: { code: "download.checksum_mismatch" } });
});

test("a blob that is corrupted three times in a row fails with download.checksum_mismatch", async () => {
  const bad = added.layerDigests[0] ?? "";
  // Corrupt every answer for this blob, not just the next one.
  const { fetch: watched } = watching({
    before: (url) => {
      if (url.pathname.endsWith(`/blobs/${bad}`)) registry.corruptNext(bad);
    },
  });
  const outcome = await download({ fetch: watched });
  expect(outcome).toEqual({ ok: false, error: { code: "download.checksum_mismatch", data: {} } });
  expect(registry.redirects(bad)).toBe(3);
  expect(existsSync(blobPath(folder, bad))).toBe(false);
  expect(existsSync(partOf(bad))).toBe(false);
  // The blobs before it are kept.
  expect(sha256Of(blobPath(folder, added.configDigest))).toBe(hexOf(added.configDigest));
});

test("a download with no bytes for the stall time fails with download.stalled", async () => {
  const stuck = added.layerDigests[0] ?? "";
  // The first try gets 1000 bytes and then silence. Every later try is refused
  // with 503, so no other byte ever arrives.
  registry.stallNext(stuck, 1000);
  const { fetch: watched } = watching({
    after: (url) => {
      if (url.pathname === `/signed/${hexOf(stuck)}`) registry.failNext(stuck, 503, 1000);
    },
  });
  const progress: ImageDownloadProgress[] = [];
  const outcome = await download({
    fetch: watched,
    idleMs: 50,
    stallMs: 300,
    onProgress: (p) => progress.push(p),
  });
  // 300 ms rounds to 0 seconds.
  expect(outcome).toEqual({ ok: false, error: { code: "download.stalled", data: { seconds: 0 } } });
  expect(sizeOf(partOf(stuck))).toBe(1000);
  expect(existsSync(blobPath(folder, stuck))).toBe(false);
  expect(progress.at(-1)?.retries).toBeGreaterThan(1);
  expect(progress.at(-1)?.lastRetry).toEqual({ code: "download.host_busy", data: { status: 503 } });
});

test("a token that expires is fetched again and the download completes", async () => {
  // The token the manifest request got stops working once the manifest is in.
  // The next token request lifts the limit again.
  const { fetch: watched } = watching({
    before: (url) => {
      if (url.pathname === "/token") registry.tokenLifetimeMs = Infinity;
    },
    after: (url, response) => {
      if (url.pathname.includes("/manifests/") && response.status === 200) registry.tokenLifetimeMs = -1;
    },
  });
  const outcome = await download({ fetch: watched });
  expect(outcome.ok).toBe(true);
  expectBlobsVerified();
  expect(registry.tokensIssued()).toBeGreaterThan(1);
});

test("a manifest whose bytes do not hash to the pinned digest fails with download.checksum_mismatch and writes nothing", async () => {
  const { fetch: watched } = watching({
    after: async (url, response) => {
      if (!url.pathname.includes("/manifests/") || response.status !== 200) return;
      const altered = new Uint8Array([...new Uint8Array(await response.arrayBuffer()), 32]);
      return new Response(altered, { status: 200, headers: { "content-type": MANIFEST_TYPE } });
    },
  });
  const outcome = await download({ fetch: watched });
  expect(outcome).toEqual({ ok: false, error: { code: "download.checksum_mismatch", data: {} } });
  expect(existsSync(folder)).toBe(false);
  expect(registry.requests.some((r) => pathOf(r).includes("/blobs/"))).toBe(false);
});

test("a digest the registry does not have is image.not_found", async () => {
  const outcome = await download({}, { ...pinned, digest: `sha256:${"0".repeat(64)}` });
  expect(outcome).toEqual({ ok: false, error: { code: "image.not_found", data: {} } });
  expect(existsSync(folder)).toBe(false);
});

test("an image index is image.unsupported_manifest", async () => {
  const index = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [{ mediaType: MANIFEST_TYPE, digest: added.digest, size: added.manifest.length }],
    }),
  );
  const outcome = await download({}, addRawManifest(index, "application/vnd.oci.image.index.v1+json"));
  expect(outcome).toEqual({ ok: false, error: { code: "image.unsupported_manifest", data: {} } });
  expect(registry.requests.some((r) => pathOf(r).includes("/blobs/"))).toBe(false);
});

test("a schema 1 manifest is image.unsupported_manifest", async () => {
  const old = new TextEncoder().encode(
    JSON.stringify({ schemaVersion: 1, name: REPOSITORY_PATH, tag: "latest", architecture: "amd64", fsLayers: [] }),
  );
  const outcome = await download({}, addRawManifest(old, "application/vnd.docker.distribution.manifest.v1+json"));
  expect(outcome).toEqual({ ok: false, error: { code: "image.unsupported_manifest", data: {} } });
  expect(registry.requests.some((r) => pathOf(r).includes("/blobs/"))).toBe(false);
});

test("the log names the image in full once, with its manifest digest, and in a short form after that", async () => {
  const lines: string[] = [];
  const outcome = await download({ log: (line) => lines.push(line) });
  expect(outcome.ok).toBe(true);
  const short = `aidm-api@${added.digest.slice(0, 19)}`;
  expect(lines[0]).toStartWith(`Image download ${short}: ${localName(pinned)}, manifest ${added.digest}, 4 blobs, `);
  // The full name with its 64 digits is in the first line only.
  expect(lines.slice(1).filter((line) => line.includes(localName(pinned)) || line.includes(added.digest))).toEqual([]);
  expect(lines.some((line) => line.includes(`layer 1 of 3 of ${short} (`))).toBe(true);
  expect(lines.at(-1)).toStartWith(`Image download ${short}: finished, `);
});
