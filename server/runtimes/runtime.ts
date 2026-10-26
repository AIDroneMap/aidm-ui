import type { ApiError } from "../../shared/api-error.ts";

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
  /** Always pinned: "<repository>@sha256:<digest>". */
  image: string;
  /** e.g. "linux/arm64"; null lets the runtime pick (Apple's tool always gets one). */
  platform: string | null;
  publish: { hostAddress: "127.0.0.1"; hostPort: number; containerPort: number };
  /**
   * Folders shared with the container. A read-only mount cannot be changed from
   * inside, which protects a folder that holds a secret or a setting.
   */
  mounts: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>;
  /** Null: no cap. */
  memoryBytes: number | null;
  cpus: number | null;
  /** Pass the GPU through (a later ticket fills the flags). */
  gpu: boolean;
  /** Arguments after the image name. */
  args: string[];
}

export type ContainerState = "running" | "stopped" | "missing";

export interface ContainerStatus {
  state: ContainerState;
  exitCode: number | null;
  oomKilled: boolean | null;
}

export interface PullProgress {
  /** Image layers finished, when the tool's output says; null when it does not. */
  layersDone: number | null;
  layersTotal: number | null;
  phase: "downloading" | "writing";
}

export type RuntimeResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface ContainerRuntime extends RuntimeProbe {
  pull(
    image: string,
    options?: { platform?: string | null; onProgress?: (progress: PullProgress) => void; signal?: AbortSignal },
  ): Promise<RuntimeResult<void>>;
  /** Detached. */
  start(spec: ContainerSpec): Promise<RuntimeResult<{ containerId: string }>>;
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
