import { EXIT_NOT_FOUND, type CommandRunner } from "../process/command-runner.ts";
import { cliRuntime, sharedRunArgs, type PullLineParser } from "./cli-runtime.ts";
import {
  asRecord,
  DETECT_TIMEOUT_MS,
  notInstalled,
  parseJson,
  unusable,
  type ContainerRuntime,
  type ContainerSpec,
  type RuntimeDetection,
} from "./runtime.ts";

/** A CDI device name, which needs the NVIDIA Container Toolkit's device list (`nvidia-ctk cdi generate`). */
export const GPU_DEVICE = "nvidia.com/gpu=all";
export const GPU_FLAGS = ["--device", GPU_DEVICE] as const;

/**
 * The command line that starts the container. The "Z" mount option labels the
 * mounted folder for SELinux, which Podman does and Docker does not, so a
 * read-only mount becomes ":ro,Z". Rootless Podman refuses a cap whose
 * controller it was not given, so each cap is left out on its own.
 */
export function runArgv(spec: ContainerSpec, detection: RuntimeDetection): string[] {
  return sharedRunArgs("podman", spec, {
    selinuxLabel: true,
    memoryCap: detection.memoryCapEnforced !== false,
    cpuCap: detection.cpuCapEnforced !== false,
    gpuFlags: GPU_FLAGS,
  });
}

/**
 * Podman prints no byte counts when its output is not a terminal. It prints
 * "Copying blob sha256:..." as it starts each layer and "Copying config" and
 * "Writing manifest" once the layers are in, so it can say how many layers
 * began but not how many finished.
 */
export function podmanPullParser(): PullLineParser {
  const blobs = new Set<string>();
  let writing = false;
  return (line) => {
    const blob = /^Copying blob (\S+)/.exec(line);
    if (blob !== null) {
      const before = blobs.size;
      blobs.add(blob[1] ?? line);
      if (blobs.size === before) return null;
    } else if (/^(Copying config|Writing manifest)/.test(line)) {
      if (writing) return null;
      writing = true;
    } else {
      return null;
    }
    const layersTotal = blobs.size === 0 ? null : blobs.size;
    return { layersDone: null, layersTotal, phase: writing ? "writing" : "downloading" };
  };
}

/** Podman's own command for one container, so a volume or an image of the same name is never read. */
const inspectArgv = (name: string): string[] => ["podman", "container", "inspect", name];

export function podmanRuntime(runner: CommandRunner, log?: (line: string) => void): ContainerRuntime {
  async function detect(): Promise<RuntimeDetection> {
    const version = await runner.run(["podman", "version", "--format", "json"], { timeoutMs: DETECT_TIMEOUT_MS });
    if (version.exitCode === EXIT_NOT_FOUND) return notInstalled("podman");
    const client = asRecord(asRecord(parseJson(version.stdout))?.Client);
    if (version.exitCode !== 0 || typeof client?.Version !== "string") return unusable("podman");

    const info = await runner.run(["podman", "info", "--format", "json"], { timeoutMs: DETECT_TIMEOUT_MS });
    const host = asRecord(asRecord(parseJson(info.stdout))?.host);
    const rootless = asRecord(host?.security)?.rootless;
    if (info.exitCode !== 0 || typeof rootless !== "boolean") return unusable("podman");

    // A rootful Podman owns its cgroup. A rootless one can cap memory or CPUs
    // only when systemd hands that controller to the user's own cgroup, and
    // it lists the controllers it was handed.
    const controllers = Array.isArray(host?.cgroupControllers) ? host.cgroupControllers : [];
    const delegated = (controller: string) => host?.cgroupVersion === "v2" && controllers.includes(controller);
    const graphRoot = asRecord(asRecord(parseJson(info.stdout))?.store)?.graphRoot;
    return {
      id: "podman",
      available: true,
      version: client.Version,
      memoryCapEnforced: rootless ? delegated("memory") : true,
      cpuCapEnforced: rootless ? delegated("cpu") : true,
      storagePath: typeof graphRoot === "string" && graphRoot !== "" ? graphRoot : null,
      problem: null,
    };
  }

  return cliRuntime({ id: "podman", detect, inspectArgv, pullParser: podmanPullParser, gpuFlags: GPU_FLAGS }, runner, runArgv, log);
}
