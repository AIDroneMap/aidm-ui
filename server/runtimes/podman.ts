import type { DownloadedImage } from "../images/image-download.ts";
import { EXIT_NOT_FOUND, type CommandResult, type CommandRunner } from "../process/command-runner.ts";
import { cliRuntime, sharedRunArgs, type LoadContext } from "./cli-runtime.ts";
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

/** The toolkit's device for every card. Its list comes from `nvidia-ctk cdi generate`. */
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
 * Podman reads an OCI image layout folder in place (libimage tries an OCI
 * folder first), so the download needs no archive and no second copy on
 * disk. It names nothing it loads from a folder, so the name is added with
 * a tag of the config digest, which is the image's ID in Podman.
 */
export async function podmanLoad(image: DownloadedImage, context: LoadContext): Promise<CommandResult> {
  const loaded = await context.stream(["podman", "load", "-i", image.folder]);
  if (loaded.exitCode !== 0) return loaded;
  return context.run(["podman", "tag", image.config.digest, image.name]);
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

  // While it copies, Podman keeps each blob in a temporary file for big files (in /var/tmp unless TMPDIR says otherwise).
  return cliRuntime({ id: "podman", detect, inspectArgv, loadCopies: 1, load: podmanLoad, gpuFlags: GPU_FLAGS }, runner, runArgv, log);
}
