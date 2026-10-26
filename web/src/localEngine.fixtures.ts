import type { CapsView, InstallProgressView, LocalEngineView } from "../../shared/api-types.ts";

const GIB = 1024 ** 3;

/** Test data: the caps of a computer with 32 GiB of memory and 8 cores. */
export const caps: CapsView = {
  memoryBytes: 14 * GIB,
  cpus: 8,
  maxMemoryBytes: 29.77 * GIB,
  maxCpus: 8,
  applied: null,
};

export const fresh: LocalEngineView = {
  platform: "linux",
  installed: null,
  engineId: null,
  enabled: true,
  startAgain: false,
  state: "not_installed",
  install: null,
  plan: null,
  caps,
  runtime: { chosen: "podman", available: ["podman", "docker"], preferred: null },
  warnings: [],
  forceCpu: false,
  problem: null,
  lastTry: null,
  restarts: null,
  update: { available: null, previous: null, blockedBy: null, applying: null },
};

/** Test data: the install of the engine alone, as on Linux. */
export function engineInstall(overrides: Partial<InstallProgressView> = {}): InstallProgressView {
  const size = overrides.size ?? 683 * 1024 ** 2;
  return {
    phase: "pulling",
    variant: "linux-amd64-cpu",
    steps: [{ id: "engine", size }],
    step: "engine",
    stepReceived: null,
    size,
    layersDone: null,
    layersTotal: null,
    speed: null,
    retries: 0,
    lastRetry: null,
    ...overrides,
  };
}

/** Test data: the steps on a Mac without Apple's container tool, with the sizes the server sends. */
export const macPlan: InstallProgressView["steps"] = [
  { id: "installer", size: 155_965_213 },
  { id: "approve", size: null },
  { id: "service", size: null },
  { id: "kernel", size: 696_573_576 },
  { id: "init", size: 69_425_005 },
  { id: "engine", size: 622_710_197 },
];

/**
 * Test data: the steps on a Mac whose tool is there but is another release than the one aidm-ui has
 * a kernel for, and has no kernel. The tool fetches its own, so the kernel's size is not sent.
 */
export const macStoppedPlan: InstallProgressView["steps"] = [
  { id: "service", size: null },
  { id: "kernel", size: null },
  { id: "engine", size: 622_710_197 },
];

/** Test data: an install on that Mac, at the given step. */
export function macInstall(step: InstallProgressView["step"], overrides: Partial<InstallProgressView> = {}): InstallProgressView {
  return engineInstall({
    phase: step === "engine" ? "pulling" : "preparing",
    steps: macPlan,
    step,
    size: 622_710_197,
    ...overrides,
  });
}
