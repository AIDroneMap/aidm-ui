import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { InstallProgressView, VariantId } from "../../shared/api-types.ts";
import {
  bytesOnDisk,
  downloadImage,
  imageFolder,
  localName,
  removeImageDownload,
  type ImageDownloadOptions,
  type ImageDownloadOutcome,
  type ImageDownloadProgress,
  type PinnedImage,
} from "../images/image-download.ts";
import { DOWNLOAD_FREE_DISK_MARGIN, IMAGE_UNPACKED_FACTOR } from "../machine/thresholds.ts";
import { isNativePackage, type InstalledPackage } from "../settings/settings.ts";
import type { FreeBytes } from "../machine/disk.ts";
import { IN_IMAGE_CHECK_TIMEOUT_MS, inImageFailed, parseGpuListing } from "../machine/gpu.ts";
import type { ManifestVariant } from "../manifest/schema.ts";
import type { ContainerRuntime, ContainerSpec, OneOffSpec } from "../runtimes/runtime.ts";
import { fail, ok, type EnginePackage, type PackageResult, type PackageStartOptions, type PackageStatus } from "./engine-package.ts";

/** The fixed name, so the manager finds the container again after a restart. */
export const CONTAINER_NAME = "aidm-local-engine";
/** Where the task API keeps its data inside the image. */
export const ENGINE_DATA_PATH = "/var/www/data";
/** The port the task API listens on inside the container. */
export const ENGINE_PORT = 3000;
/** Where the folder with the task API's config file is mounted inside the container. */
export const ENGINE_CONFIG_FOLDER_IN_CONTAINER = "/etc/aidm-ui";
export const ENGINE_CONFIG_FILE_NAME = "task-api.json";

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
}

export const registryImages: ImageSource = { download: downloadImage };

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
  /** Default: the image downloader, against the registry the variant names. */
  images?: ImageSource;
  /** Passed to the image downloader; tests make them short. */
  download?: Pick<ImageDownloadOptions, "fetch" | "stallMs" | "idleMs" | "backoffMs" | "now">;
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
    let last: ImageDownloadProgress = { received: 0, total: variant.size, bytesPerSecond: null, blobsDone: 0, blobsTotal: 0, retries: 0, lastRetry: null };
    const view = (phase: "pulling" | "loading"): InstallProgressView => ({
      phase,
      variant: this.deps.variantId,
      steps: [{ id: "engine", size: variant.size }],
      step: "engine",
      stepReceived: last.received,
      size: variant.size,
      layersDone: last.blobsTotal === 0 ? null : last.blobsDone,
      layersTotal: last.blobsTotal === 0 ? null : last.blobsTotal,
      speed: phase === "pulling" ? last.bytesPerSecond : null,
      retries: last.retries,
      lastRetry: last.lastRetry,
    });
    options.onProgress?.(view("pulling"));
    const downloaded = await (this.deps.images ?? registryImages).download(this.pinned, this.folder, {
      ...this.deps.download,
      signal: options.signal,
      onProgress: (progress) => {
        last = progress;
        options.onProgress?.(view("pulling"));
      },
    });
    if (!downloaded.ok) return fail("install.pull_failed", { cause: downloaded.error });

    options.onProgress?.(view("loading"));
    const loaded = await runtime.load(downloaded.image, { signal: options.signal });
    if (!loaded.ok) return fail("install.load_failed", { cause: loaded.error });
    const verified = await runtime.verifyImage(downloaded.image);
    if (!verified.ok) return fail("install.load_failed", { cause: verified.error });
    this.runAs = verified.value;
    this.loadedRef = verified.value;
    return ok(undefined);
  }

  installedAs(installed: InstalledPackage): InstalledPackage {
    if (this.loadedRef === null || isNativePackage(installed)) return installed;
    return { ...installed, imageRef: this.loadedRef };
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
    if (!ran.ok) return { ok: false, error: inImageFailed() };
    const { exitCode, stdout } = ran.value;
    if (exitCode === 0 && parseGpuListing(stdout).length > 0) return ok(undefined);
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

    const configFolder = containerConfigFolder(this.deps.dataFolder);
    try {
      writeEngineConfig(configFolder, options.token);
    } catch {
      return fail("local.engine_config_write_failed", {});
    }

    const spec: ContainerSpec = {
      name: CONTAINER_NAME,
      image: this.runAs,
      platform: null,
      publish: { hostAddress: "127.0.0.1", hostPort: options.hostPort, containerPort: ENGINE_PORT },
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
    return ok({ address: `http://127.0.0.1:${options.hostPort}` });
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
function writeEngineConfig(folder: string, token: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  // A folder that already exists keeps its old mode otherwise.
  chmodSync(folder, 0o700);
  const file = join(folder, ENGINE_CONFIG_FILE_NAME);
  const temporary = `${file}.new`;
  rmSync(temporary, { force: true });
  const config = { token, port: ENGINE_PORT, parallelQueueProcessing: 1 };
  writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}
