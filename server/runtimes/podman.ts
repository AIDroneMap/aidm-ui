import { EXIT_NOT_FOUND, type CommandRunner } from "../process/command-runner.ts";
import {
  asRecord,
  notInstalled,
  parseJson,
  unusable,
  type ContainerRuntime,
  type RuntimeDetection,
} from "./runtime.ts";

export function podmanRuntime(runner: CommandRunner): ContainerRuntime {
  return {
    id: "podman",
    async detect(): Promise<RuntimeDetection> {
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
    },
  };
}
