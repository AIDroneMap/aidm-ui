import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import { downloadVerified, sizeOf, type DownloadOptions } from "../downloads/downloader.ts";
import { speedMeter } from "../downloads/speed.ts";
import { DOWNLOAD_STALL_MS } from "../machine/thresholds.ts";
import { locate, RegistryClient } from "./registry-client.ts";

/** An image as a manifest entry pins it. */
export interface PinnedImage {
  /** e.g. "ghcr.io/aidronemap/aidm-api" */
  repository: string;
  /** The digest of the image manifest, "sha256:<hex>". */
  digest: string;
  /**
   * The name the loaded image gets, when it must be one a runtime looks for
   * (Apple's startup files). Default: localName, the repository with the
   * digest as its tag.
   */
  name?: string;
}

/** One blob of an image: its digest and size, from the manifest. */
export interface BlobEntry {
  digest: string;
  size: number;
}

/** An image whose manifest and blobs are all on disk and checked, laid out as an OCI image layout. */
export interface DownloadedImage {
  pinned: PinnedImage;
  /** Holds `oci-layout`, `index.json` and `blobs/sha256/<hex>`. */
  folder: string;
  /** The name the runtimes give the image when they load it. */
  name: string;
  manifest: { digest: string; size: number; mediaType: string };
  config: BlobEntry;
  layers: BlobEntry[];
}

export interface ImageDownloadProgress {
  /** Bytes of the config and the layers on disk. */
  received: number;
  /** The config and the layers, from the manifest. */
  total: number;
  /** Over the last seconds, while bytes arrive. Null until there is enough to tell. */
  bytesPerSecond: number | null;
  blobsDone: number;
  blobsTotal: number;
  /** How often a connection broke and the download went on from the last byte. */
  retries: number;
  /** Why the last connection broke, as a message code. */
  lastRetry: ApiError | null;
}

export interface ImageDownloadOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: ImageDownloadProgress) => void;
  stallMs?: number;
  idleMs?: number;
  backoffMs?: DownloadOptions["backoffMs"];
  now?: () => number;
}

export type ImageDownloadOutcome = { ok: true; image: DownloadedImage } | { ok: false; error: ApiError };

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const DIGEST = /^sha256:([0-9a-f]{64})$/;
/** A blob that fails its check this many times in a row is not the registry's mistake of the moment. */
const CHECKSUM_TRIES = 3;

/** The name the runtimes keep an image under: the repository, with the manifest digest as its tag. */
export function localName(pinned: PinnedImage): string {
  return `${pinned.repository}:sha256-${hexOf(pinned.digest)}`;
}

function hexOf(digest: string): string {
  return DIGEST.exec(digest)?.[1] ?? digest.replace(/^sha256:/, "");
}

/** The folder in the data folder where one image is downloaded. */
export function imageFolder(dataFolder: string, pinned: PinnedImage): string {
  return join(dataFolder, "downloads", "images", `sha256-${hexOf(pinned.digest)}`);
}

export function blobPath(folder: string, digest: string): string {
  return join(folder, "blobs", "sha256", hexOf(digest));
}

/** Bytes of the image already on disk, finished or not, so the disk check counts only what is left. */
export function bytesOnDisk(folder: string): number {
  const blobs = join(folder, "blobs", "sha256");
  if (!existsSync(blobs)) return 0;
  return readdirSync(blobs).reduce((sum, file) => sum + sizeOf(join(blobs, file)), 0);
}

/** Deletes one image's download. Used once the runtime holds the image. */
export function removeImageDownload(folder: string): void {
  rmSync(folder, { recursive: true, force: true });
}

function fail(code: ApiError["code"], data: Record<string, unknown> = {}): ImageDownloadOutcome {
  return { ok: false, error: { code, data } };
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function asBlob(value: unknown): BlobEntry | null {
  const entry = value as { digest?: unknown; size?: unknown } | null;
  if (typeof entry?.digest !== "string" || !DIGEST.test(entry.digest)) return null;
  if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) return null;
  return { digest: entry.digest, size: entry.size };
}

/** The config and layers of an image manifest, or null for anything else (an index, a schema 1 manifest). */
function readManifest(bytes: Uint8Array): { mediaType: string; config: BlobEntry; layers: BlobEntry[] } | null {
  let parsed: { mediaType?: unknown; schemaVersion?: unknown; config?: unknown; layers?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (parsed.schemaVersion !== 2) return null;
  const mediaType = parsed.mediaType ?? OCI_MANIFEST;
  if (mediaType !== OCI_MANIFEST && mediaType !== DOCKER_MANIFEST) return null;
  const config = asBlob(parsed.config);
  if (config === null || !Array.isArray(parsed.layers)) return null;
  const layers = parsed.layers.map(asBlob);
  if (layers.some((layer) => layer === null)) return null;
  return { mediaType, config, layers: layers as BlobEntry[] };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}

/** The manifest's bytes, from disk when an earlier download kept them, else from the registry, always checked against the digest. */
async function manifestBytes(
  registry: RegistryClient,
  pinned: PinnedImage,
  folder: string,
  options: ImageDownloadOptions,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: ApiError }> {
  const path = blobPath(folder, pinned.digest);
  if (existsSync(path)) {
    const kept = new Uint8Array(readFileSync(path));
    if (sha256Hex(kept) === hexOf(pinned.digest)) return { ok: true, bytes: kept };
    rmSync(path, { force: true });
  }
  const now = options.now ?? Date.now;
  const stallMs = options.stallMs ?? DOWNLOAD_STALL_MS;
  const since = now();
  const location = locate(pinned.repository);
  for (let tries = 1; ; tries++) {
    if (options.signal?.aborted) return { ok: false, error: { code: "download.cancelled", data: {} } };
    const answer = await registry.manifest(location, pinned.digest, options.signal);
    if (answer.ok) {
      if (sha256Hex(answer.bytes) !== hexOf(pinned.digest)) return { ok: false, error: { code: "download.checksum_mismatch", data: {} } };
      mkdirSync(join(folder, "blobs", "sha256"), { recursive: true });
      writeFileSync(`${path}.part`, answer.bytes);
      renameSync(`${path}.part`, path);
      return { ok: true, bytes: answer.bytes };
    }
    if (options.signal?.aborted) return { ok: false, error: { code: "download.cancelled", data: {} } };
    if (answer.final) return { ok: false, error: answer.error };
    const left = stallMs - (now() - since);
    if (left <= 0) return { ok: false, error: { code: "download.stalled", data: { seconds: Math.round(stallMs / 1000) } } };
    await sleep(Math.min((options.backoffMs ?? ((n) => Math.min(1000 * 2 ** (n - 1), 30_000)))(tries), left), options.signal);
  }
}

/**
 * Downloads one image blob by blob: the manifest by its pinned digest, then
 * the config and each layer, each in requests of its own, so no connection
 * stays open for the whole image. A broken connection goes on from the last
 * byte on disk with a fresh signed address. Every blob is checked against
 * its digest before it counts. The blobs stay in the data folder until the
 * caller removes them, so a later call after a restart continues from them.
 */
export async function downloadImage(
  pinned: PinnedImage,
  folder: string,
  options: ImageDownloadOptions = {},
): Promise<ImageDownloadOutcome> {
  if (!DIGEST.test(pinned.digest)) return fail("image.unsupported_manifest", {});
  const registry = new RegistryClient(options.fetch);
  const location = locate(pinned.repository);
  const now = options.now ?? Date.now;

  const got = await manifestBytes(registry, pinned, folder, options);
  if (!got.ok) return got;
  const manifest = readManifest(got.bytes);
  if (manifest === null) return fail("image.unsupported_manifest", {});

  // A layer that appears twice is downloaded once.
  const seen = new Set<string>();
  const blobs = [manifest.config, ...manifest.layers].filter((blob) => !seen.has(blob.digest) && seen.add(blob.digest));
  const total = blobs.reduce((sum, blob) => sum + blob.size, 0);

  let done = 0;
  let doneBytes = 0;
  let retries = 0;
  let lastRetry: ApiError | null = null;
  const speed = speedMeter(now);
  const report = (received: number) => {
    const bytesPerSecond = speed(received);
    options.onProgress?.({ received, total, bytesPerSecond, blobsDone: done, blobsTotal: blobs.length, retries, lastRetry });
  };
  report(0);

  for (const blob of blobs) {
    const path = blobPath(folder, blob.digest);
    for (let checks = 1; ; checks++) {
      const outcome = await downloadVerified(
        { url: `${location.base}/v2/${location.name}/blobs/${blob.digest}`, size: blob.size, sha256: hexOf(blob.digest), path },
        {
          request: registry.blobRequest(location, blob.digest),
          signal: options.signal,
          checkSpace: false,
          stallMs: options.stallMs,
          idleMs: options.idleMs,
          backoffMs: options.backoffMs,
          now,
          onProgress: (received) => report(doneBytes + received),
          onRetry: (reason) => {
            retries++;
            lastRetry = reason;
            report(doneBytes + sizeOf(`${path}.part`));
          },
        },
      );
      if (outcome.ok) break;
      // A blob that fails its check is discarded alone; the others stay.
      if (outcome.error.code !== "download.checksum_mismatch" || checks >= CHECKSUM_TRIES) return outcome;
      retries++;
      lastRetry = outcome.error;
    }
    done++;
    doneBytes += blob.size;
    report(doneBytes);
  }

  const name = pinned.name ?? localName(pinned);
  writeLayout(folder, { digest: pinned.digest, size: got.bytes.length, mediaType: manifest.mediaType }, name);
  return {
    ok: true,
    image: {
      pinned,
      folder,
      name,
      manifest: { digest: pinned.digest, size: got.bytes.length, mediaType: manifest.mediaType },
      config: manifest.config,
      layers: manifest.layers,
    },
  };
}

/**
 * Makes the folder an OCI image layout: the version file, and an index that
 * names the one manifest. The name is in the two annotations the runtimes
 * read: the containerd one with the whole name (Docker, Podman and Apple's
 * tool read it first) and the OCI one with the tag alone, as the OCI
 * specification has it.
 */
function writeLayout(folder: string, manifest: { digest: string; size: number; mediaType: string }, name: string): void {
  const tag = name.slice(name.lastIndexOf(":") + 1);
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: manifest.mediaType,
        digest: manifest.digest,
        size: manifest.size,
        annotations: { "io.containerd.image.name": name, "org.opencontainers.image.ref.name": tag },
      },
    ],
  };
  writeFileSync(join(folder, "oci-layout"), `${JSON.stringify({ imageLayoutVersion: "1.0.0" })}\n`);
  writeFileSync(join(folder, "index.json"), `${JSON.stringify(index)}\n`);
}
