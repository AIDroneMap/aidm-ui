import type { ApiError } from "../../shared/api-error.ts";
import type { InstallProgressView } from "../../shared/api-types.ts";

export interface PackageStartOptions {
  /** A free port on the loopback interface. */
  hostPort: number;
  token: string;
  /** Null: no cap. */
  memoryBytes: number | null;
  cpus: number | null;
  engineDataFolder: string;
  gpu: boolean;
}

export type PackageStatus = { state: "running" | "stopped" | "missing"; exitCode: number | null };

export type PackageResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/**
 * One kind of engine package, container or native, behind the one interface
 * the engine manager uses. The manager does the update and the rollback of
 * either kind itself, with these calls.
 */
export interface EnginePackage {
  readonly kind: "container" | "native";
  /** What can be known without downloading: the free disk. Nothing is fetched when this refuses. */
  preflight(): Promise<PackageResult<void>>;
  install(options: {
    onProgress?: (progress: InstallProgressView) => void;
    signal?: AbortSignal;
  }): Promise<PackageResult<void>>;
  /**
   * Starts the engine detached. The address is `http://127.0.0.1:<hostPort>`.
   * `memoryCapEnforced` is false when a memory limit was asked for and the
   * engine runs without it.
   */
  start(options: PackageStartOptions): Promise<PackageResult<{ address: string; memoryCapEnforced?: boolean }>>;
  stop(): Promise<PackageResult<void>>;
  status(): Promise<PackageResult<PackageStatus>>;
  logs(options: {
    follow: boolean;
    tail?: number;
    onLine: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<PackageResult<void>>;
  /** Only the container (for a native package, the program), forced; the image or the folder stays. For clearing away a start that went wrong. */
  removeContainer(): Promise<PackageResult<void>>;
  /** This version's container and image, or its folder. */
  remove(): Promise<PackageResult<void>>;
}

export function ok<T>(value: T): PackageResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: ApiError["code"], data: Record<string, unknown> = {}): PackageResult<T> {
  return { ok: false, error: { code, data } };
}
