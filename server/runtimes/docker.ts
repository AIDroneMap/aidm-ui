import { EXIT_NOT_FOUND, type CommandRunner } from "../process/command-runner.ts";
import {
  asRecord,
  notInstalled,
  parseJson,
  unavailable,
  unusable,
  type ContainerRuntime,
  type RuntimeDetection,
} from "./runtime.ts";

export function dockerRuntime(runner: CommandRunner): ContainerRuntime {
  return {
    id: "docker",
    async detect(): Promise<RuntimeDetection> {
      const version = await runner.run(["docker", "version", "--format", "json"]);
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

      const info = await runner.run(["docker", "info", "--format", "json"]);
      const details = info.exitCode === 0 ? asRecord(parseJson(info.stdout)) : undefined;
      return {
        id: "docker",
        available: true,
        version: server.Version,
        memoryCapEnforced: typeof details?.MemoryLimit === "boolean" ? details.MemoryLimit : null,
        problem: null,
      };
    },
  };
}
