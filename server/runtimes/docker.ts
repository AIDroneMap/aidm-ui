import { EXIT_NOT_FOUND, type CommandRunner } from "../process/command-runner.ts";
import { cliRuntime, sharedRunArgs, type PullLineParser } from "./cli-runtime.ts";
import {
  asRecord,
  DETECT_TIMEOUT_MS,
  notInstalled,
  parseJson,
  unavailable,
  unusable,
  type ContainerRuntime,
  type ContainerSpec,
  type RuntimeDetection,
} from "./runtime.ts";

/** Needs the NVIDIA Container Toolkit set up for Docker (an "nvidia" runtime). */
export const GPU_FLAGS = ["--gpus", "all"] as const;

/** The command line that starts the container. Docker adds no SELinux label, so a mount has no option unless it is read-only (":ro"). */
export function runArgv(spec: ContainerSpec, detection: RuntimeDetection): string[] {
  return sharedRunArgs("docker", spec, {
    selinuxLabel: false,
    memoryCap: detection.memoryCapEnforced !== false,
    cpuCap: detection.cpuCapEnforced !== false,
    gpuFlags: GPU_FLAGS,
  });
}

/** Limited to containers, so an image or a volume of the same name is never read. */
const inspectArgv = (name: string): string[] => ["docker", "inspect", "--type", "container", name];

/**
 * Docker's plain pull output names each layer as "<id>: Pulling fs layer" and
 * later "<id>: Pull complete" (or "Already exists"). Once every layer says
 * "Download complete", what is left is unpacking them.
 */
export function dockerPullParser(): PullLineParser {
  const layers = new Set<string>();
  const downloaded = new Set<string>();
  const done = new Set<string>();
  let last = "";
  return (line) => {
    const match = /^([0-9a-f]{12,64}): (.+)$/.exec(line);
    if (match === null) return null;
    const [, id = "", status = ""] = match;
    if (status === "Pulling fs layer") layers.add(id);
    if (status === "Download complete" && layers.has(id)) downloaded.add(id);
    if (status === "Pull complete" || status === "Already exists") {
      layers.add(id);
      downloaded.add(id);
      done.add(id);
    }
    if (layers.size === 0) return null;
    const progress = {
      layersDone: done.size,
      layersTotal: layers.size,
      phase: downloaded.size >= layers.size ? ("writing" as const) : ("downloading" as const),
    };
    const key = JSON.stringify(progress);
    if (key === last) return null;
    last = key;
    return progress;
  };
}

export function dockerRuntime(runner: CommandRunner, log?: (line: string) => void): ContainerRuntime {
  async function detect(): Promise<RuntimeDetection> {
    const version = await runner.run(["docker", "version", "--format", "json"], { timeoutMs: DETECT_TIMEOUT_MS });
    if (version.exitCode === EXIT_NOT_FOUND) return notInstalled("docker");
    const parsed = asRecord(parseJson(version.stdout));
    if (parsed === undefined) return unusable("docker");

    // With the daemon out of reach the client still prints its half, with
    // Server null, and exits 1.
    const server = asRecord(parsed.Server);
    if (server === undefined || version.exitCode !== 0) {
      if (/permission denied/i.test(version.stderr)) {
        return unavailable("docker", { code: "runtime.docker_permission_denied", data: { runtime: "docker" } });
      }
      return unavailable("docker", { code: "runtime.docker_daemon_unreachable", data: { runtime: "docker" } });
    }
    if (typeof server.Version !== "string") return unusable("docker");

    const info = await runner.run(["docker", "info", "--format", "json"], { timeoutMs: DETECT_TIMEOUT_MS });
    const details = info.exitCode === 0 ? asRecord(parseJson(info.stdout)) : undefined;
    return {
      id: "docker",
      available: true,
      version: server.Version,
      memoryCapEnforced: typeof details?.MemoryLimit === "boolean" ? details.MemoryLimit : null,
      cpuCapEnforced: typeof details?.CpuCfsQuota === "boolean" ? details.CpuCfsQuota : null,
      storagePath: typeof details?.DockerRootDir === "string" && details.DockerRootDir !== "" ? details.DockerRootDir : null,
      problem: null,
    };
  }

  return cliRuntime({ id: "docker", detect, inspectArgv, pullParser: dockerPullParser, gpuFlags: GPU_FLAGS }, runner, runArgv, log);
}
