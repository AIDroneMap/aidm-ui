import type { CapsView, LocalEngineView } from "../../shared/api-types.ts";

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
  installed: null,
  engineId: null,
  state: "not_installed",
  install: null,
  caps,
  runtime: { chosen: "podman", available: ["podman", "docker"], preferred: null },
  warnings: [],
  problem: null,
};
