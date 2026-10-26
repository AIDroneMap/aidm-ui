import { gatherMachineFacts, type MachineFacts } from "../server/machine/facts.ts";
import { ScriptedRunner, recorded, recordedText, type ScriptedRule } from "./scripted-runner.ts";

const GiB = 1024 ** 3;

/** What a computer would answer, in recorded form. Change it between two checks to move the computer. */
export interface MachineInputs {
  platform: string;
  arch: string;
  /** The text of /proc/cpuinfo, or null when it cannot be read. */
  cpuInfo: string | null;
  totalMemory: number;
  freeDisk: number;
  /** The commands that answer; every other command is not installed. */
  rules: ScriptedRule[];
}

export function linuxInputs(overrides: Partial<MachineInputs> = {}): MachineInputs {
  return {
    platform: "linux",
    arch: "x64",
    cpuInfo: recordedText("cpuinfo", "x86-64-avx2"),
    totalMemory: 32 * GiB,
    freeDisk: 100 * GiB,
    rules: [],
    ...overrides,
  };
}

type PodmanInfo = "info-rootless" | "info-rootless-no-memory" | "info-rootful" | "info-rootful-no-memory";

export function podmanRules(info: PodmanInfo): ScriptedRule[] {
  return [
    { argv: ["podman", "version", "--format", "json"], result: recorded("podman", "version") },
    { argv: ["podman", "info", "--format", "json"], result: recorded("podman", info) },
  ];
}

type DockerVersion = "version" | "version-no-daemon" | "version-permission-denied";

export function dockerRules(version: DockerVersion, info: "info" | "info-rootless" = "info"): ScriptedRule[] {
  return [
    { argv: ["docker", "version", "--format", "json"], result: recorded("docker", version) },
    { argv: ["docker", "info", "--format", "json"], result: recorded("docker", info) },
  ];
}

export function appleRules(started: boolean): ScriptedRule[] {
  return [
    {
      argv: ["container", "system", "version", "--format", "json"],
      result: recorded("apple-container", started ? "system-version" : "system-version-not-started"),
    },
    {
      argv: ["container", "system", "status", "--format", "json"],
      result: recorded("apple-container", started ? "system-status-running" : "system-status-not-running"),
    },
  ];
}

export const NVIDIA_RULE: ScriptedRule = { argv: ["nvidia-smi", "-L"], result: recorded("nvidia", "smi-l") };

/** A computer for the route tests: gathers its facts from the recorded inputs as they are at that moment. */
export interface RecordedMachine {
  inputs: MachineInputs;
  gather(): Promise<MachineFacts>;
  /** Every command the last gathers ran. */
  readonly calls: string[][];
}

export function recordedMachine(initial: MachineInputs = linuxInputs()): RecordedMachine {
  const machine: RecordedMachine = {
    inputs: initial,
    calls: [],
    gather() {
      const inputs = machine.inputs;
      const runner = new ScriptedRunner(inputs.rules);
      return gatherMachineFacts({
        platform: inputs.platform,
        arch: inputs.arch,
        runner,
        readFile: (path) => (path === "/proc/cpuinfo" ? inputs.cpuInfo : null),
        totalMemory: () => inputs.totalMemory,
        freeBytes: () => inputs.freeDisk,
        dataFolder: "/data",
      }).finally(() => machine.calls.push(...runner.calls));
    },
  };
  return machine;
}
