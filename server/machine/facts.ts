import { allRuntimes } from "../runtimes/registry.ts";
import type { RuntimeDetection } from "../runtimes/runtime.ts";
import type { CommandRunner } from "../process/command-runner.ts";
import type { FreeBytes } from "./disk.ts";

export interface MachineFacts {
  /** process.platform */
  platform: string;
  /** process.arch */
  arch: string;
  /** /proc/cpuinfo on Linux, null elsewhere or when it cannot be read. */
  cpuInfo: string | null;
  /** `sw_vers -productVersion` on macOS. */
  macosVersion: string | null;
  /** Bytes. */
  totalMemory: number;
  /** Bytes free where the engine data will live (the data folder for now). */
  freeDisk: number;
  nvidia: { driverAnswers: boolean; gpus: string[] };
  runtimes: RuntimeDetection[];
}

export interface MachineFactsDeps {
  platform: string;
  arch: string;
  runner: CommandRunner;
  /** The text of a file, or null when it cannot be read. */
  readFile: (path: string) => string | null;
  totalMemory: () => number;
  freeBytes: FreeBytes;
  dataFolder: string;
}

async function nvidiaFacts(runner: CommandRunner): Promise<MachineFacts["nvidia"]> {
  const listing = await runner.run(["nvidia-smi", "-L"]);
  if (listing.exitCode !== 0) return { driverAnswers: false, gpus: [] };
  const gpus = listing.stdout.split("\n").filter((line) => /^GPU \d+:/.test(line));
  return { driverAnswers: true, gpus };
}

async function macosVersion(runner: CommandRunner): Promise<string | null> {
  const answer = await runner.run(["sw_vers", "-productVersion"]);
  const version = answer.stdout.trim();
  return answer.exitCode === 0 && version !== "" ? version : null;
}

/** Everything the machine check decides by. It runs commands side by side. */
export async function gatherMachineFacts(deps: MachineFactsDeps): Promise<MachineFacts> {
  const linux = deps.platform === "linux";
  const [nvidia, version, runtimes] = await Promise.all([
    linux ? nvidiaFacts(deps.runner) : { driverAnswers: false, gpus: [] },
    deps.platform === "darwin" ? macosVersion(deps.runner) : null,
    Promise.all(allRuntimes(deps.runner, deps.platform).map((runtime) => runtime.detect())),
  ]);
  return {
    platform: deps.platform,
    arch: deps.arch,
    cpuInfo: linux ? deps.readFile("/proc/cpuinfo") : null,
    macosVersion: version,
    totalMemory: deps.totalMemory(),
    freeDisk: deps.freeBytes(deps.dataFolder),
    nvidia,
    runtimes,
  };
}
