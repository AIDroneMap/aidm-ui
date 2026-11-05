import { allRuntimes } from "../runtimes/registry.ts";
import type { RuntimeDetection } from "../runtimes/runtime.ts";
import type { CommandRunner } from "../process/command-runner.ts";
import type { FreeBytes } from "./disk.ts";
import { gpuApplies, NVIDIA_QUERY_ARGV, parseGpuListing, parseGpuQuery } from "./gpu.ts";

export interface MachineFacts {
  /** process.platform */
  platform: string;
  /** process.arch */
  arch: string;
  /** /proc/cpuinfo on Linux, null elsewhere or when it cannot be read. */
  cpuInfo: string | null;
  /** Whether Windows reports AVX2 on the processor; null elsewhere or when the call cannot be made. */
  avx2: boolean | null;
  /** The build number Windows reports, such as 26100; null elsewhere or when it cannot be read. */
  windowsBuild: number | null;
  /** `sw_vers -productVersion` on macOS. */
  macosVersion: string | null;
  /** The name a Linux system gives itself (PRETTY_NAME in /etc/os-release), or null. */
  linuxName: string | null;
  /** Bytes. */
  totalMemory: number;
  /** Bytes free where the engine data will live (the data folder for now). */
  freeDisk: number;
  /**
   * The NVIDIA driver and its cards: on Linux the lines of `nvidia-smi -L`, on
   * Windows the card names. The driver version is read on Windows only, where
   * the offer compares it with the CUDA package's driver floor.
   */
  nvidia: { driverAnswers: boolean; gpus: string[]; driverVersion: string | null };
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
  /** os.release(): on Windows "10.0." and the build number. */
  osRelease: () => string;
  /** The AVX2 answer of Windows, or null when it cannot be asked. Called on Windows only. */
  windowsHasAvx2: () => boolean | null;
}

const NO_NVIDIA: MachineFacts["nvidia"] = { driverAnswers: false, gpus: [], driverVersion: null };

async function nvidiaFacts(runner: CommandRunner): Promise<MachineFacts["nvidia"]> {
  const listing = await runner.run(["nvidia-smi", "-L"]);
  if (listing.exitCode !== 0) return NO_NVIDIA;
  return { driverAnswers: true, gpus: parseGpuListing(listing.stdout), driverVersion: null };
}

/** On Windows the driver is asked for its cards and its version in one query. No container tool is asked. */
async function windowsNvidiaFacts(runner: CommandRunner): Promise<MachineFacts["nvidia"]> {
  const answer = await runner.run(NVIDIA_QUERY_ARGV);
  if (answer.exitCode !== 0) return NO_NVIDIA;
  const { gpus, driverVersion } = parseGpuQuery(answer.stdout);
  if (gpus.length === 0) return NO_NVIDIA;
  return { driverAnswers: true, gpus, driverVersion };
}

/** The build number in os.release() on Windows ("10.0.26100" gives 26100), or null. */
export function windowsBuild(release: string): number | null {
  const match = /^\d+\.\d+\.(\d+)/.exec(release.trim());
  return match === null ? null : Number.parseInt(match[1]!, 10);
}

/** Windows on an Intel or AMD processor: the only Windows the engine packages exist for. */
export function windowsX64(facts: { platform: string; arch: string }): boolean {
  return facts.platform === "win32" && facts.arch === "x64";
}

async function macosVersion(runner: CommandRunner): Promise<string | null> {
  const answer = await runner.run(["sw_vers", "-productVersion"]);
  const version = answer.stdout.trim();
  return answer.exitCode === 0 && version !== "" ? version : null;
}

/** PRETTY_NAME from the text of an os-release file, without its quotes. */
export function prettyName(osRelease: string | null): string | null {
  const match = /^PRETTY_NAME=(.*)$/m.exec(osRelease ?? "");
  const name = match?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  return name === undefined || name === "" ? null : name;
}

/** Everything the machine check decides by. It runs commands side by side. */
export async function gatherMachineFacts(deps: MachineFactsDeps): Promise<MachineFacts> {
  const linux = deps.platform === "linux";
  const windows = deps.platform === "win32";
  // The graphics card packages exist for Intel and AMD processors only, so no NVIDIA command runs elsewhere.
  const nvidiaFor = gpuApplies(deps) ? nvidiaFacts : windowsX64(deps) ? windowsNvidiaFacts : null;
  const [nvidia, version, runtimes] = await Promise.all([
    nvidiaFor === null ? NO_NVIDIA : nvidiaFor(deps.runner),
    deps.platform === "darwin" ? macosVersion(deps.runner) : null,
    Promise.all(allRuntimes(deps.runner, deps.platform).map((runtime) => runtime.detect())),
  ]);
  return {
    platform: deps.platform,
    arch: deps.arch,
    cpuInfo: linux ? deps.readFile("/proc/cpuinfo") : null,
    avx2: windowsX64(deps) ? deps.windowsHasAvx2() : null,
    windowsBuild: windows ? windowsBuild(deps.osRelease()) : null,
    macosVersion: version,
    linuxName: linux ? prettyName(deps.readFile("/etc/os-release")) : null,
    totalMemory: deps.totalMemory(),
    freeDisk: deps.freeBytes(deps.dataFolder),
    nvidia,
    runtimes,
  };
}
