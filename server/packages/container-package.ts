import type { ApiError } from "../../shared/api-error.ts";
import type { InstallProgressView } from "../../shared/api-types.ts";
import { DOWNLOAD_FREE_DISK_MARGIN } from "../machine/thresholds.ts";
import type { FreeBytes } from "../machine/disk.ts";
import type { ManifestVariant } from "../manifest/schema.ts";
import type { ContainerRuntime, ContainerSpec } from "../runtimes/runtime.ts";
import { fail, ok, type EnginePackage, type PackageResult, type PackageStartOptions, type PackageStatus } from "./engine-package.ts";

/** The fixed name, so the manager finds the container again after a restart. */
export const CONTAINER_NAME = "aidm-local-engine";
/** Where the task API keeps its data inside the image. */
export const ENGINE_DATA_PATH = "/var/www/data";
/** The port the task API listens on inside the container. */
export const ENGINE_PORT = 3000;
export const PULL_ATTEMPTS = 5;
/** Seconds to wait after each failed try: 2, 4, 8, 16. */
const BACKOFF_SECONDS = [2, 4, 8, 16];

export type ContainerVariant = Extract<ManifestVariant, { kind: "container" }>;

export interface ContainerPackageDeps {
  runtime: ContainerRuntime;
  variant: ContainerVariant;
  freeBytes: FreeBytes;
  /** Where the runtime keeps images, when it says; the pull lands there. */
  storagePath: string | null;
  /** The folder checked when the runtime does not say where it keeps images. */
  dataFolder: string;
  /** Waits for the given milliseconds; a test passes one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** An engine package that is an image run through a container runtime. */
export class ContainerPackage implements EnginePackage {
  readonly kind = "container";
  /** Always the digest, never a tag, so what runs is what the manifest signed. */
  readonly image: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ContainerPackageDeps) {
    this.image = `${deps.variant.image}@${deps.variant.digest}`;
    this.sleep = deps.sleep ?? ((ms) => Bun.sleep(ms));
  }

  async preflight(): Promise<PackageResult<void>> {
    const needed = Math.ceil(this.deps.variant.size * (1 + DOWNLOAD_FREE_DISK_MARGIN));
    const free = this.deps.freeBytes(this.deps.storagePath ?? this.deps.dataFolder);
    if (free < needed) return fail("install.not_enough_space", { needed, free });
    return ok(undefined);
  }

  async install(options: {
    onProgress?: (progress: InstallProgressView) => void;
    signal?: AbortSignal;
  }): Promise<PackageResult<void>> {
    // Checked again right before the pull, since the preflight may be a while ago.
    const space = await this.preflight();
    if (!space.ok) return space;

    const { runtime, variant } = this.deps;
    let attempts = 0;
    let cause: ApiError | null = null;
    for (let attempt = 1; attempt <= PULL_ATTEMPTS; attempt++) {
      attempts = attempt;
      const view = (layers: { done: number | null; total: number | null }): InstallProgressView => ({
        phase: "pulling",
        size: variant.size,
        layersDone: layers.done,
        layersTotal: layers.total,
        attempt,
        maxAttempts: PULL_ATTEMPTS,
      });
      options.onProgress?.(view({ done: null, total: null }));
      // Completed layers are reused by the runtime, so a retry is the same pull again.
      const pulled = await runtime.pull(this.image, {
        signal: options.signal,
        onProgress: (progress) =>
          options.onProgress?.(view({ done: progress.layersDone, total: progress.layersTotal })),
      });
      if (pulled.ok) return ok(undefined);
      cause = pulled.error;
      // A missing image will not appear by asking again.
      if (options.signal?.aborted || attempt === PULL_ATTEMPTS || pulled.error.code === "runtime.image_not_found") break;
      await this.sleep((BACKOFF_SECONDS[attempt - 1] ?? 16) * 1000);
    }
    return fail("install.pull_failed", { attempts, cause });
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

    const spec: ContainerSpec = {
      name: CONTAINER_NAME,
      image: this.image,
      platform: null,
      publish: { hostAddress: "127.0.0.1", hostPort: options.hostPort, containerPort: ENGINE_PORT },
      mounts: [{ hostPath: options.engineDataFolder, containerPath: ENGINE_DATA_PATH }],
      memoryBytes: options.memoryBytes,
      cpus: options.cpus,
      gpu: options.gpu,
      args: ["--port", String(ENGINE_PORT), "--token", options.token, "--parallel_queue_processing", "1"],
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

  async remove(): Promise<PackageResult<void>> {
    const container = await this.deps.runtime.remove(CONTAINER_NAME);
    if (!container.ok) return container;
    return this.deps.runtime.removeImage(this.image);
  }
}
