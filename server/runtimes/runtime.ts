import type { ApiError } from "../../shared/api-error.ts";

export type RuntimeId = "podman" | "docker" | "apple-container";

export interface RuntimeDetection {
  id: RuntimeId;
  /** The tool answers and can run containers. */
  available: boolean;
  version: string | null;
  /** Whether a memory cap would be enforced (rootless Podman without cgroup delegation cannot). Null when unknown. */
  memoryCapEnforced: boolean | null;
  /** Why it is not available, as a code with its data. */
  problem: ApiError | null;
}

/** Later tickets add pull, start, stop, status, logs and remove to this interface. */
export interface ContainerRuntime {
  readonly id: RuntimeId;
  detect(): Promise<RuntimeDetection>;
}

export function unavailable(id: RuntimeId, problem: ApiError): RuntimeDetection {
  return { id, available: false, version: null, memoryCapEnforced: null, problem };
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
