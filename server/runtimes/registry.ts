import type { CommandRunner } from "../process/command-runner.ts";
import { appleContainerRuntime } from "./apple-container.ts";
import { dockerRuntime } from "./docker.ts";
import { podmanRuntime } from "./podman.ts";
import type { ContainerRuntime, RuntimeDetection, RuntimeId, RuntimeProbe } from "./runtime.ts";

/** The runtimes worth asking about on this platform. Windows has none yet. */
export function allRuntimes(runner: CommandRunner, platform: string): RuntimeProbe[] {
  if (platform === "darwin") return [appleContainerRuntime(runner)];
  if (platform === "linux") return [podmanRuntime(runner), dockerRuntime(runner)];
  return [];
}

/** Podman is tried before Docker, because rootless Podman needs no administrator. */
const ORDER: RuntimeId[] = ["podman", "docker", "apple-container"];

/**
 * The runtime to use: the one the operator chose if it answers, else Podman
 * over Docker. A choice that no longer answers is ignored, so a stale setting
 * cannot hide a runtime that works.
 */
export function preferredRuntime(
  detections: RuntimeDetection[],
  chosen: RuntimeId | null = null,
): RuntimeDetection | null {
  const available = detections.filter((detection) => detection.available);
  const picked = chosen === null ? undefined : available.find((detection) => detection.id === chosen);
  if (picked !== undefined) return picked;
  for (const id of ORDER) {
    const found = available.find((detection) => detection.id === id);
    if (found !== undefined) return found;
  }
  return null;
}

/** The runtime that can run containers: Podman or Docker for now. Apple's tool joins in a later ticket. */
export function containerRuntime(
  id: RuntimeId,
  runner: CommandRunner,
  log?: (line: string) => void,
): ContainerRuntime | null {
  if (id === "podman") return podmanRuntime(runner, log);
  if (id === "docker") return dockerRuntime(runner, log);
  return null;
}
