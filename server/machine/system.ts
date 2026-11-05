import { readFileSync } from "node:fs";
import os from "node:os";
import { systemRunner, type CommandRunner } from "../process/command-runner.ts";
import { freeBytes } from "./disk.ts";
import { gatherMachineFacts, type MachineFacts } from "./facts.ts";
import { windowsHasAvx2, windowsNativeArch } from "./windows.ts";

/** The real computer, for the running server. The runner is the server's, so the machine check's commands are logged and recorded like the others. */
export function systemMachine(dataFolder: string, runner: CommandRunner = systemRunner()): { gather(): Promise<MachineFacts> } {
  return {
    gather: () =>
      gatherMachineFacts({
        platform: process.platform,
        // On Windows the computer's own processor, which emulation hides from process.arch.
        arch: (process.platform === "win32" ? windowsNativeArch() : null) ?? process.arch,
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
        osRelease: os.release,
        windowsHasAvx2,
      }),
  };
}
