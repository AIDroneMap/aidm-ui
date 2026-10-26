import { readFileSync } from "node:fs";
import os from "node:os";
import { systemRunner } from "../process/command-runner.ts";
import { freeBytes } from "./disk.ts";
import { gatherMachineFacts, type MachineFacts } from "./facts.ts";

/** The real computer, for the running server. */
export function systemMachine(dataFolder: string): { gather(): Promise<MachineFacts> } {
  const runner = systemRunner();
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
