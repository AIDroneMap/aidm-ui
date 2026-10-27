import type { ApiError } from "../../shared/api-error.ts";
import type { DownloadedImage } from "../images/image-download.ts";
import type { CommandResult } from "../process/command-runner.ts";

import type { RuntimeId } from "../../shared/api-types.ts";

export type { RuntimeId };

export interface RuntimeDetection {
  id: RuntimeId;
  /** The tool answers and can run containers. */
  available: boolean;
  version: string | null;
  /** Whether a memory cap would be enforced (rootless Podman without cgroup delegation cannot). Null when unknown. */
  memoryCapEnforced: boolean | null;
  /** Whether a CPU cap would be enforced. Separate from memory, because a system can hand over one controller and not the other. Null when unknown. */
  cpuCapEnforced: boolean | null;
  /** The folder where the runtime keeps images and containers, so the disk check measures the right disk. Null when the tool does not say. */
  storagePath: string | null;
  /** Why it is not available, as a code with its data. */
  problem: ApiError | null;
}

/** What the machine check needs from a runtime: a name and a way to ask whether it works. */
export interface RuntimeProbe {
  readonly id: RuntimeId;
  detect(): Promise<RuntimeDetection>;
}

export interface ContainerSpec {
  /** Fixed, so the manager finds the container again. */
  name: string;
  /**
   * Always pinned to the image's content: the reference verifyImage gave for
   * an image aidm-ui loaded, or "<repository>@sha256:<digest>" for one the
   * runtime pulled itself before ADR 0005.
   */
  image: string;
  /** e.g. "linux/arm64"; null lets the runtime pick. Apple's tool takes the platform at the pull and has no platform flag for run. */
  platform: string | null;
  /** The task API's port on the loopback interface. Null for an engine reached through `publishSocket` alone. */
  publish: { hostAddress: "127.0.0.1"; hostPort: number; containerPort: number } | null;
  /**
   * A Unix socket inside the container relayed to one on this computer
   * (Apple's tool: `--publish-socket host:container`, ADR 0006). The program
   * inside listens on `containerPath`; the tool makes `hostPath` at each start.
   */
  publishSocket?: { hostPath: string; containerPath: string };
  /**
   * Folders shared with the container. A read-only mount cannot be changed from
   * inside, which protects a folder that holds a secret or a setting.
   */
  mounts: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>;
  /** Null: no cap. */
  memoryBytes: number | null;
  cpus: number | null;
  /** Pass the graphics card through: Docker `--gpus all`, Podman `--device nvidia.com/gpu=all`. */
  gpu: boolean;
  /** Arguments after the image name. */
  args: string[];
}

/** A container that runs one command and is removed. It has no ports, mounts or caps. */
export interface OneOffSpec {
  /** Fixed, so a run that hangs or is cut short can be found and removed. */
  name: string;
  image: string;
  platform: string | null;
  gpu: boolean;
  /** Replaces the image's own entry point. */
  entrypoint?: string;
  args: string[];
}

export type ContainerState = "running" | "stopped" | "missing";

export interface ContainerStatus {
  state: ContainerState;
  exitCode: number | null;
  oomKilled: boolean | null;
}

export type RuntimeResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface ContainerRuntime extends RuntimeProbe {
  /**
   * How many copies of the download a load puts on the runtime's disk, for a
   * while or for good, next to the unpacked layers: an archive the tool keeps
   * while it reads, a folder it unpacks the archive into, a content store.
   * The disk check counts them.
   */
  readonly loadCopies: number;
  /**
   * Hands an image that aidm-ui downloaded to the runtime with the tool's own
   * load command (ADR 0005). Only the exit status counts, never a line of
   * output. It does not prove the runtime holds the right image: verifyImage does.
   */
  load(image: DownloadedImage, options?: { signal?: AbortSignal }): Promise<RuntimeResult<void>>;
  /**
   * The reference to run a loaded image by, once the runtime has shown that it
   * holds the image under its name with the manifest digest or the config
   * digest of the download. runtime.image_not_verified otherwise.
   */
  verifyImage(image: DownloadedImage): Promise<RuntimeResult<string>>;
  /** Detached. */
  start(spec: ContainerSpec): Promise<RuntimeResult<{ containerId: string }>>;
  /**
   * Runs one command in a new container and waits for it. Never pulls. The
   * result is ok whatever the command's exit code was. The container is
   * removed by `--rm`, and by name when the run fails, times out or is aborted.
   */
  runOnce(spec: OneOffSpec, timeoutMs: number, signal?: AbortSignal): Promise<RuntimeResult<CommandResult>>;
  stop(name: string, timeoutSeconds?: number): Promise<RuntimeResult<void>>;
  status(name: string): Promise<RuntimeResult<ContainerStatus>>;
  /** Resolves when the log stream ends (container gone, follow false, or signal). */
  logs(
    name: string,
    options: { follow: boolean; tail?: number; onLine: (line: string) => void; signal?: AbortSignal },
  ): Promise<RuntimeResult<void>>;
  /** The container, forced; a missing one is fine. */
  remove(name: string): Promise<RuntimeResult<void>>;
  /** An image no longer needed; a missing one is fine. */
  removeImage(image: string): Promise<RuntimeResult<void>>;
}

export function ok<T>(value: T): RuntimeResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: ApiError["code"], data: Record<string, unknown> = {}): RuntimeResult<T> {
  return { ok: false, error: { code, data } };
}

export function unavailable(id: RuntimeId, problem: ApiError): RuntimeDetection {
  return { id, available: false, version: null, memoryCapEnforced: null, cpuCapEnforced: null, storagePath: null, problem };
}

export function notInstalled(id: RuntimeId): RuntimeDetection {
  return unavailable(id, { code: "runtime.not_installed", data: { runtime: id } });
}

/** The tool is there but its answer made no sense. */
export function unusable(id: RuntimeId): RuntimeDetection {
  return unavailable(id, { code: "runtime.unusable", data: { runtime: id } });
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * How long detect waits for each answer. The first run of a runtime on a fresh
 * computer sets up its storage and can take many seconds (about 9 s for
 * Podman on a GitHub-hosted runner).
 */
export const DETECT_TIMEOUT_MS = 60_000;
