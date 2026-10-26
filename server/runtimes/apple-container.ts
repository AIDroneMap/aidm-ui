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

/** Apple's container tool. Its VMs always have a memory size, so a cap is always enforced. */
export function appleContainerRuntime(runner: CommandRunner): ContainerRuntime {
  return {
    id: "apple-container",
    async detect(): Promise<RuntimeDetection> {
      // The command line half answers even when the system service is off.
      const version = await runner.run(["container", "system", "version", "--format", "json"]);
      if (version.exitCode === EXIT_NOT_FOUND) return notInstalled("apple-container");
      const rows = parseJson(version.stdout);
      const cli = Array.isArray(rows) ? rows.map(asRecord).find((row) => row?.appName === "container") : undefined;
      if (version.exitCode !== 0 || typeof cli?.version !== "string") return unusable("apple-container");

      // Not running prints its status and exits 1, so the answer is read from
      // the text and not from the exit code alone.
      const status = await runner.run(["container", "system", "status", "--format", "json"]);
      const state = asRecord(parseJson(status.stdout))?.status;
      if (status.exitCode !== 0 || state !== "running") {
        if (state === "not running" || state === "unregistered") {
          return {
            ...unavailable("apple-container", { code: "runtime.apple_not_started", data: {} }),
            version: cli.version,
          };
        }
        return unusable("apple-container");
      }
      return {
        id: "apple-container",
        available: true,
        version: cli.version,
        memoryCapEnforced: true,
        problem: null,
      };
    },
  };
}
