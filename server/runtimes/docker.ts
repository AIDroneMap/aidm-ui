import { imageArchive } from "../images/image-archive.ts";
import type { DownloadedImage } from "../images/image-download.ts";
import { EXIT_NOT_FOUND, type CommandResult, type CommandRunner } from "../process/command-runner.ts";
import { cliRuntime, sharedRunArgs, type LoadContext } from "./cli-runtime.ts";
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

/** Needs the NVIDIA toolkit set up as a Docker runtime. */
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
 * `docker load` reads an archive on its standard input and the client
 * streams it to the daemon, so the archive is made from the blobs as it goes
 * and never lands on disk. The archive is both an OCI image layout and a
 * `docker save` archive: Docker's classic image store reads only the
 * `manifest.json` of the second, and its containerd store reads the first
 * and keeps the manifest digest. Both name the image from it.
 */
export function dockerLoad(image: DownloadedImage, context: LoadContext): Promise<CommandResult> {
  return context.stream(["docker", "load"], imageArchive(image, "oci+docker"));
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

  // The classic store unpacks the archive into a temporary folder first; the containerd store keeps the blobs in its content store.
  return cliRuntime({ id: "docker", detect, inspectArgv, loadCopies: 1, load: dockerLoad, loadFailureLine: /Error unpacking image/i, gpuFlags: GPU_FLAGS }, runner, runArgv, log);
}
