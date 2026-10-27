import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { InstallProgressView, VariantId } from "../../shared/api-types.ts";
import {
  bytesOnDisk,
  downloadImage,
  fetchManifestLayers,
  imageFolder,
  localName,
  removeImageDownload,
  type BlobEntry,
  type ImageDownloadOptions,
  type ImageDownloadOutcome,
  type DownloadedImage,
  type ImageDownloadProgress,
  type PinnedImage,
} from "../images/image-download.ts";
import { excerpt } from "../app/diagnosis-log.ts";
import { DOWNLOAD_FREE_DISK_MARGIN, IMAGE_UNPACKED_FACTOR } from "../machine/thresholds.ts";
import { isNativePackage, type InstalledContainerPackage, type InstalledPackage } from "../settings/settings.ts";
import type { FreeBytes } from "../machine/disk.ts";
import { IN_IMAGE_CHECK_TIMEOUT_MS, inImageFailed, parseGpuListing } from "../machine/gpu.ts";
import type { ManifestVariant } from "../manifest/schema.ts";
import type { ContainerRuntime, ContainerSpec, KnownImage, OneOffSpec, RuntimeId } from "../runtimes/runtime.ts";
import { SOCKET_ADDRESS_PREFIX } from "../task-api/task-client.ts";
import { fail, ok, type EnginePackage, type PackageResult, type PackageStartOptions, type PackageStatus } from "./engine-package.ts";

/** The errors that a second load, with the skipped layers downloaded, can cure. */
const RETRYABLE = new Set(["install.load_failed", "install.image_not_verified"]);

/** The fixed name, so the manager finds the container again after a restart. */
export const CONTAINER_NAME = "aidm-local-engine";
/** Where the task API keeps its data inside the image. */
export const ENGINE_DATA_PATH = "/var/www/data";
/** The port the task API listens on inside the container. */
export const ENGINE_PORT = 3000;
/** Where the folder with the task API's config file is mounted inside the container. */
export const ENGINE_CONFIG_FOLDER_IN_CONTAINER = "/etc/aidm-ui";
export const ENGINE_CONFIG_FILE_NAME = "task-api.json";
/** Where the task API listens inside the container when it can use a socket (ADR 0006). Every engine image has /run. */
export const ENGINE_SOCKET_IN_CONTAINER = "/run/task-api.sock";
/** A Unix socket path on macOS holds 104 bytes with the closing zero (sun_path). */
export const MAX_SOCKET_PATH_BYTES = 103;

/** The socket on this computer that Apple's tool relays the task API to. */
export function engineSocketPath(dataFolder: string): string {
  return join(resolve(dataFolder), "run", "task-api.sock");
}

/**
 * How aidm-ui reaches the engine of this package (ADR 0006): through a socket
 * when Apple's tool runs it, the manifest says its task API can listen on one,
 * and the path fits; else through the published port. `tooLong` is the
 * length of a path that did not fit, so the log can say why.
 */
export function connectionFor(
  runtime: RuntimeId,
  variant: ContainerVariant,
  dataFolder: string,
): { via: "socket"; path: string } | { via: "port"; tooLong: number | null } {
  if (runtime !== "apple-container" || variant.taskApiSocket !== true) return { via: "port", tooLong: null };
  const path = engineSocketPath(dataFolder);
  const length = Buffer.byteLength(path);
  return length > MAX_SOCKET_PATH_BYTES ? { via: "port", tooLong: length } : { via: "socket", path };
}

/**
 * The folder on this computer that holds the task API's config file. It holds
 * only that file, because the whole folder is mounted read-only into the
 * container. The file has the token, so the folder is readable by this user only.
 */
export function containerConfigFolder(dataFolder: string): string {
  return join(resolve(dataFolder), "engine-config", "container");
}
export type ContainerVariant = Extract<ManifestVariant, { kind: "container" }>;

/** How a container package gets its image; the real one is the image downloader, a test passes one that needs no registry. */
export interface ImageSource {
  download(pinned: PinnedImage, folder: string, options: ImageDownloadOptions): Promise<ImageDownloadOutcome>;
  /** The layers of an image as the registry lists them, null when it cannot say. A source with no registry leaves this out. */
  layers?(pinned: PinnedImage, options: { fetch?: typeof fetch; signal?: AbortSignal; log?: (line: string) => void }): Promise<BlobEntry[] | null>;
}

export const registryImages: ImageSource = { download: downloadImage, layers: fetchManifestLayers };

export interface ContainerPackageDeps {
  runtime: ContainerRuntime;
  variant: ContainerVariant;
  /** Which entry of the manifest the variant is, for the progress. */
  variantId: VariantId;
  freeBytes: FreeBytes;
  /** Where the runtime keeps images, when it says; the load lands there. */
  storagePath: string | null;
  /** The downloads go here, and it is the folder checked when the runtime does not say where it keeps images. */
  dataFolder: string;
  /** The reference the runtime runs the image by, from the settings; absent before the image is loaded, or for an image the runtime pulled itself. */
  imageRef?: string;
  /**
   * The container packages installed on this runtime earlier (the installed
   * and the previous one). The runtime may hold layers of their images that
   * this image shares, and the download then leaves those out.
   */
  known?: () => InstalledContainerPackage[];
  /** Default: the image downloader, against the registry the variant names. */
  images?: ImageSource;
  /** Passed to the image downloader; tests make them short. */
  download?: Pick<ImageDownloadOptions, "fetch" | "stallMs" | "idleMs" | "backoffMs" | "now">;
  /** The diagnosis log. */
  log?: (line: string) => void;
}

/** An engine package that is an image run through a container runtime. */
export class ContainerPackage implements EnginePackage {
  readonly kind = "container";
  /** Always the digest, never a tag, so what runs is what the manifest signed. */
  readonly image: string;
  private readonly pinned: PinnedImage;
  /** What the runtime runs: the reference verifyImage gave, else the pinned image. */
  private runAs: string;
  private loadedRef: string | null = null;
  /** Every layer of the image that was loaded, for the record. */
  private loadedLayers: BlobEntry[] | null = null;

  constructor(private readonly deps: ContainerPackageDeps) {
    this.pinned = { repository: deps.variant.image, digest: deps.variant.digest };
    this.image = `${deps.variant.image}@${deps.variant.digest}`;
    this.runAs = deps.imageRef ?? this.image;
  }

  private get folder(): string {
    return imageFolder(this.deps.dataFolder, this.pinned);
  }

  /**
   * The disk the whole install needs, counted before anything is downloaded:
   * the bytes of the download still to come in the data folder, and in the
   * runtime's storage the copies its load makes and the unpacked layers. When
   * both are on one disk, that disk needs the sum.
   */
  async preflight(options: { dataFolderExtra?: number } = {}): Promise<PackageResult<void>> {
    const size = this.deps.variant.size;
    const margin = DOWNLOAD_FREE_DISK_MARGIN * size;
    const forDownload = Math.max(0, size - bytesOnDisk(this.folder)) + margin + (options.dataFolderExtra ?? 0);
    const forRuntime = Math.ceil((this.deps.runtime.loadCopies + IMAGE_UNPACKED_FACTOR) * size + margin);
    const storage = this.deps.storagePath ?? this.deps.dataFolder;
    const checks = sameDisk(this.deps.dataFolder, storage)
      ? [{ path: this.deps.dataFolder, needed: Math.ceil(forDownload + forRuntime) }]
      : [
          { path: this.deps.dataFolder, needed: Math.ceil(forDownload) },
          { path: storage, needed: forRuntime },
        ];
    for (const { path, needed } of checks) {
      const free = this.deps.freeBytes(path);
      if (free < needed) return fail("install.not_enough_space", { needed, free });
    }
    return ok(undefined);
  }

  /**
   * Downloads the image with the image downloader, hands it to the runtime
   * with the runtime's load, and checks that the runtime holds it with the
   * pinned digest (ADR 0005). The download stays on disk until
   * discardDownload(), so a failed load is tried again without downloading.
   */
  async install(options: {
    onProgress?: (progress: InstallProgressView) => void;
    signal?: AbortSignal;
  }): Promise<PackageResult<void>> {
    // Checked again right before the download, since the preflight may be a while ago.
    const space = await this.preflight();
    if (!space.ok) return space;

    const { runtime, variant } = this.deps;
    let last: ImageDownloadProgress = { received: 0, total: variant.size, reused: 0, bytesPerSecond: null, blobsDone: 0, blobsTotal: 0, retries: 0, lastRetry: null };
    // Until the download reports its total, the variant's size stands in for it.
    let reported = false;
    const view = (phase: "pulling" | "loading"): InstallProgressView => ({
      phase,
      variant: this.deps.variantId,
      steps: [{ id: "engine", size: variant.size }],
      step: "engine",
      stepReceived: last.received,
      size: reported ? last.total : variant.size,
      reusedBytes: last.reused,
      layersDone: last.blobsTotal === 0 ? null : last.blobsDone,
      layersTotal: last.blobsTotal === 0 ? null : last.blobsTotal,
      speed: phase === "pulling" ? last.bytesPerSecond : null,
      retries: last.retries,
      lastRetry: last.lastRetry,
    });
    options.onProgress?.(view("pulling"));
    const known = await this.knownImages(options.signal);
    const fetchImage = (held: ImageDownloadOptions["held"]) =>
      (this.deps.images ?? registryImages).download(this.pinned, this.folder, {
        ...this.deps.download,
        log: this.deps.log,
        signal: options.signal,
        held,
        onProgress: (progress) => {
          last = progress;
          reported = true;
          options.onProgress?.(view("pulling"));
        },
      });
    // Hands the downloaded image to the runtime and checks that it holds it.
    const handOver = async (image: DownloadedImage): Promise<PackageResult<string>> => {
      options.onProgress?.(view("loading"));
      const loaded = await runtime.load(image, { signal: options.signal });
      // Each failure has its own message: a load the tool refused, and a load whose result is not the image downloaded.
      if (!loaded.ok) {
        if (loaded.error.code !== "runtime.load_failed") return loaded;
        return fail("install.load_failed", { exitCode: loaded.error.data.exitCode ?? null });
      }
      const verified = await runtime.verifyImage(image);
      if (!verified.ok) {
        if (verified.error.code !== "runtime.image_not_verified") return verified;
        return fail("install.image_not_verified", {});
      }
      return ok(verified.value);
    };

    let downloaded = await fetchImage((layers) => runtime.heldLayers(layers, known));
    if (!downloaded.ok) return fail("install.pull_failed", { cause: downloaded.error });
    let handed = await handOver(downloaded.image);
    // The runtime did not take the image without the layers it was thought to hold. Only they are missing from the folder, so only they are fetched.
    if (!handed.ok && downloaded.image.skipped.length > 0 && !options.signal?.aborted && RETRYABLE.has(handed.error.code)) {
      this.deps.log?.(
        `The runtime did not take the image without ${downloaded.image.skipped.length} layers it was thought to hold (${handed.error.code}). Downloading them and loading the image again.`,
      );
      downloaded = await fetchImage(async () => new Set());
      if (!downloaded.ok) return fail("install.pull_failed", { cause: downloaded.error });
      handed = await handOver(downloaded.image);
    }
    if (!handed.ok) return handed;
    this.runAs = handed.value;
    this.loadedRef = handed.value;
    this.loadedLayers = downloaded.image.layers;
    return ok(undefined);
  }

  /** The images of earlier installs on this runtime with their layers: from the record, else from the manifest at the registry. A record whose layers cannot be had is left out. */
  private async knownImages(signal: AbortSignal | undefined): Promise<KnownImage[]> {
    const images: KnownImage[] = [];
    for (const record of this.deps.known?.() ?? []) {
      const layers =
        record.layers ??
        (await (this.deps.images ?? registryImages).layers?.(
          { repository: record.container.image, digest: record.container.digest },
          { fetch: this.deps.download?.fetch, signal, log: this.deps.log },
        )) ??
        null;
      if (layers === null) continue;
      images.push({
        ref: record.imageRef ?? `${record.container.image}@${record.container.digest}`,
        layers: layers.map(({ digest, size }) => ({ digest, size })),
      });
    }
    return images;
  }

  installedAs(installed: InstalledPackage): InstalledPackage {
    if (this.loadedRef === null || isNativePackage(installed)) return installed;
    return {
      ...installed,
      imageRef: this.loadedRef,
      ...(this.loadedLayers === null ? {} : { layers: this.loadedLayers.map(({ digest, size }) => ({ digest, size })) }),
    };
  }

  discardDownload(): void {
    removeImageDownload(this.folder);
  }

  /**
   * Check c: the driver's listing, run once inside the pulled image with the
   * graphics card passed through. It never pulls, so it is for after install().
   */
  async confirmGpu(signal?: AbortSignal): Promise<PackageResult<void>> {
    const spec: OneOffSpec = {
      name: `${CONTAINER_NAME}-gpu-check`,
      image: this.runAs,
      platform: null,
      gpu: true,
      entrypoint: "nvidia-smi",
      args: ["-L"],
    };
    const ran = await this.deps.runtime.runOnce(spec, IN_IMAGE_CHECK_TIMEOUT_MS, signal);
    if (!ran.ok) {
      this.deps.log?.(`Graphics card check failed: the test run could not be started: ${ran.error.code}`);
      return { ok: false, error: inImageFailed() };
    }
    const { exitCode, stdout, stderr } = ran.value;
    if (exitCode === 0 && parseGpuListing(stdout).length > 0) return ok(undefined);
    this.deps.log?.(`Graphics card check failed: expected exit 0 and at least one card listed by nvidia-smi -L, found exit ${exitCode}: ${excerpt(stdout || stderr)}`);
    return { ok: false, error: inImageFailed(exitCode) };
  }

  async start(options: PackageStartOptions): Promise<PackageResult<{ address: string }>> {
    const { runtime } = this.deps;
    // A container with our name from an earlier start must go, or the name is taken.
    const leftover = await runtime.status(CONTAINER_NAME);
    if (!leftover.ok) return leftover;
    if (leftover.value.state !== "missing") {
      const removed = await runtime.remove(CONTAINER_NAME);
      if (!removed.ok) return removed;
    }

    const connection = connectionFor(runtime.id, this.deps.variant, this.deps.dataFolder);
    if (connection.via === "port" && connection.tooLong !== null) {
      this.deps.log?.(
        `The engine is reached through its port: the socket path in the data folder would be ${connection.tooLong} bytes, and macOS allows ${MAX_SOCKET_PATH_BYTES}.`,
      );
    }
    const configFolder = containerConfigFolder(this.deps.dataFolder);
    try {
      if (connection.via === "socket") {
        mkdirSync(dirname(connection.path), { recursive: true, mode: 0o700 });
        // The tool refuses a socket file that is already there. One left by a
        // container that did not stop cleanly is ours: the leftover is gone.
        rmSync(connection.path, { force: true });
      }
      writeEngineConfig(configFolder, options.token, connection.via === "socket" ? ENGINE_SOCKET_IN_CONTAINER : null);
    } catch {
      return fail("local.engine_config_write_failed", {});
    }

    const spec: ContainerSpec = {
      name: CONTAINER_NAME,
      image: this.runAs,
      platform: null,
      publish: connection.via === "socket" ? null : { hostAddress: "127.0.0.1", hostPort: options.hostPort, containerPort: ENGINE_PORT },
      ...(connection.via === "socket" ? { publishSocket: { hostPath: connection.path, containerPath: ENGINE_SOCKET_IN_CONTAINER } } : {}),
      mounts: [
        { hostPath: options.engineDataFolder, containerPath: ENGINE_DATA_PATH, readOnly: false },
        { hostPath: configFolder, containerPath: ENGINE_CONFIG_FOLDER_IN_CONTAINER, readOnly: true },
      ],
      memoryBytes: options.memoryBytes,
      cpus: options.cpus,
      gpu: options.gpu,
      // The token is in the config file. Every user of the computer can read
      // this command line, and the runtime's inspect command shows it.
      args: ["--config", `${ENGINE_CONFIG_FOLDER_IN_CONTAINER}/${ENGINE_CONFIG_FILE_NAME}`],
    };
    const started = await runtime.start(spec);
    if (!started.ok) return started;
    this.deps.log?.(
      connection.via === "socket"
        ? `The engine is reached through the socket ${connection.path}, with no port and no network.`
        : `The engine is reached through port ${options.hostPort} on 127.0.0.1.`,
    );
    return ok({ address: connection.via === "socket" ? `${SOCKET_ADDRESS_PREFIX}${connection.path}` : `http://127.0.0.1:${options.hostPort}` });
  }

  stop(): Promise<PackageResult<void>> {
    return this.deps.runtime.stop(CONTAINER_NAME);
  }

  async status(): Promise<PackageResult<PackageStatus>> {
    const result = await this.deps.runtime.status(CONTAINER_NAME);
    if (!result.ok) return result;
    return ok({ state: result.value.state, exitCode: result.value.exitCode });
  }

  logs(options: {
    follow: boolean;
    tail?: number;
    onLine: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<PackageResult<void>> {
    return this.deps.runtime.logs(CONTAINER_NAME, options);
  }

  removeContainer(): Promise<PackageResult<void>> {
    return this.deps.runtime.remove(CONTAINER_NAME);
  }

  /**
   * Only the image, for one that turned out not to be the right one, with its
   * download. A loaded image goes by its name, which removes that name and
   * leaves alone any other name the operator gave the same image.
   */
  async removeImage(): Promise<PackageResult<void>> {
    removeImageDownload(this.folder);
    const loaded = this.runAs !== this.image;
    return this.deps.runtime.removeImage(loaded ? localName(this.pinned) : this.image);
  }

  async remove(): Promise<PackageResult<void>> {
    const container = await this.deps.runtime.remove(CONTAINER_NAME);
    if (!container.ok) return container;
    const image = await this.removeImage();
    if (!image.ok) return image;
    rmSync(containerConfigFolder(this.deps.dataFolder), { recursive: true, force: true });
    return ok(undefined);
  }
}

/** True when two folders are on the same disk, or when that cannot be told: then the larger need is checked in one place. */
function sameDisk(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return true;
  }
}

/**
 * Writes the task API's config file. The file is written next to its final name
 * and renamed, so the engine never reads half a file. Both the folder and the
 * file are private to this user, because the file holds the token.
 */
function writeEngineConfig(folder: string, token: string, socket: string | null): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  // A folder that already exists keeps its old mode otherwise.
  chmodSync(folder, 0o700);
  const file = join(folder, ENGINE_CONFIG_FILE_NAME);
  const temporary = `${file}.new`;
  rmSync(temporary, { force: true });
  // The port stays open inside the container even with the socket: the connection checks knock on it from inside.
  const config = { token, port: ENGINE_PORT, parallelQueueProcessing: 1, ...(socket === null ? {} : { socket }) };
  writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}
