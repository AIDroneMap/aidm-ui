import type { ApiError } from "../../shared/api-error.ts";
import { MEMORY_CAP_MIN, MEMORY_RESERVE_MIN, MEMORY_RESERVE_SHARE } from "../machine/thresholds.ts";

export interface Caps {
  memoryBytes: number;
  cpus: number;
}

/** The most the local engine may have: total memory less the reserve, and every core. */
export function defaultCaps(totalMemory: number, cpuCount: number): Caps {
  const reserve = Math.max(MEMORY_RESERVE_MIN, totalMemory * MEMORY_RESERVE_SHARE);
  return {
    memoryBytes: Math.max(MEMORY_CAP_MIN, Math.floor(totalMemory - reserve)),
    cpus: Math.max(1, Math.floor(cpuCount)),
  };
}

/** The operator's caps checked against the limits. The first problem found wins, memory before CPUs. */
export function checkCaps(caps: Caps, max: Caps): { ok: true } | { ok: false; error: ApiError } {
  if (!Number.isSafeInteger(caps.memoryBytes) || caps.memoryBytes < MEMORY_CAP_MIN || caps.memoryBytes > max.memoryBytes) {
    return { ok: false, error: { code: "caps.memory_invalid", data: { min: MEMORY_CAP_MIN, max: max.memoryBytes } } };
  }
  if (!Number.isSafeInteger(caps.cpus) || caps.cpus < 1 || caps.cpus > max.cpus) {
    return { ok: false, error: { code: "caps.cpus_invalid", data: { min: 1, max: max.cpus } } };
  }
  return { ok: true };
}
