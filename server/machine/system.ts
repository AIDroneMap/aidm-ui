import { readFileSync } from "node:fs";
import os from "node:os";
import { systemRunner, type CommandRunner } from "../process/command-runner.ts";
import { freeBytes } from "./disk.ts";
import { gatherMachineFacts, type MachineFacts } from "./facts.ts";

/** The real computer, for the running server. The runner is the server's, so the machine check's commands are logged and recorded like the others. */
export function systemMachine(dataFolder: string, runner: CommandRunner = systemRunner()): { gather(): Promise<MachineFacts> } {
  return {
    gather: () =>
      gatherMachineFacts({
        platform: process.platform,
        arch: process.arch,
        runner,
        readFile: (path) => {
          try {
            return readFileSync(path, "utf8");
          } catch {
            return null;
          }
        },
        totalMemory: os.totalmem,
        freeBytes,
        dataFolder,
      }),
  };
}
