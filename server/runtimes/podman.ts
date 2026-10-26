import { EXIT_NOT_FOUND, type CommandRunner } from "../process/command-runner.ts";
import { cliRuntime, sharedRunArgs, type PullLineParser } from "./cli-runtime.ts";
import {
  asRecord,
  notInstalled,
  parseJson,
  unusable,
  type ContainerRuntime,
  type ContainerSpec,
  type RuntimeDetection,
} from "./runtime.ts";

/**
 * The command line that starts the container. ":Z" labels the mounted folder
 * for SELinux, which Podman does and Docker does not. Rootless Podman without
 * the memory controller refuses a memory or CPU cap, so then both are left out.
 */
export function runArgv(spec: ContainerSpec, detection: RuntimeDetection): string[] {
  return sharedRunArgs("podman", spec, { mountSuffix: ":Z", capsApply: detection.memoryCapEnforced !== false });
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

export function podmanRuntime(runner: CommandRunner, log?: (line: string) => void): ContainerRuntime {
  async function detect(): Promise<RuntimeDetection> {
    const version = await runner.run(["podman", "version", "--format", "json"]);
    if (version.exitCode === EXIT_NOT_FOUND) return notInstalled("podman");
    const client = asRecord(asRecord(parseJson(version.stdout))?.Client);
    if (version.exitCode !== 0 || typeof client?.Version !== "string") return unusable("podman");

    const info = await runner.run(["podman", "info", "--format", "json"]);
    const host = asRecord(asRecord(parseJson(info.stdout))?.host);
    const rootless = asRecord(host?.security)?.rootless;
    if (info.exitCode !== 0 || typeof rootless !== "boolean") return unusable("podman");

    // A rootful Podman owns its cgroup. A rootless one can cap memory only
    // when systemd hands the memory controller to the user's own cgroup, and
    // it lists the controllers it was handed.
    const controllers = Array.isArray(host?.cgroupControllers) ? host.cgroupControllers : [];
    const memoryCapEnforced = rootless ? host?.cgroupVersion === "v2" && controllers.includes("memory") : true;
    return { id: "podman", available: true, version: client.Version, memoryCapEnforced, problem: null };
  }

  return cliRuntime({ id: "podman", detect, pullParser: podmanPullParser }, runner, runArgv, log);
}
