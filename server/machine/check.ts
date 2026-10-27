import type { ApiError } from "../../shared/api-error.ts";
import type { CheckLine, MachineCheckView } from "../../shared/api-types.ts";
import type { MessageCode } from "../../shared/message-codes.ts";
import { preferredRuntime } from "../runtimes/registry.ts";
import type { RuntimeId } from "../runtimes/runtime.ts";
import { missingCpuFeatures } from "./cpu.ts";
import type { MachineFacts } from "./facts.ts";
import { gpuApplies } from "./gpu.ts";
import { RAM_REFUSE_BELOW, RAM_WARN_BELOW, RUN_FREE_DISK } from "./thresholds.ts";

/** The first macOS that Apple's container tool runs on. */
const MACOS_MINIMUM = 26;

function line(
  id: CheckLine["id"],
  result: CheckLine["result"],
  code: MessageCode,
  data: ApiError["data"] = {},
): CheckLine {
  return { id, result, message: { code, data } };
}

function platformLine(facts: MachineFacts): CheckLine {
  const { platform, arch } = facts;
  if (platform === "win32") return line("platform", "fail", "machine.windows_not_yet");
  if (platform === "darwin") {
    if (arch !== "arm64") return line("platform", "fail", "machine.mac_intel");
    const major = facts.macosVersion === null ? Number.NaN : Number.parseInt(facts.macosVersion, 10);
    // An unreadable version is not held against the operator; the install step checks again.
    if (major < MACOS_MINIMUM) {
      return line("platform", "fail", "machine.macos_too_old", { version: facts.macosVersion, minimumVersion: MACOS_MINIMUM });
    }
    // The line names the version it found, so the operator can see what was read.
    if (facts.macosVersion !== null) return line("platform", "pass", "machine.platform_ok_macos", { version: facts.macosVersion });
    return line("platform", "pass", "machine.platform_ok");
  }
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    if (facts.linuxName !== null) return line("platform", "pass", "machine.platform_ok_linux", { name: facts.linuxName });
    return line("platform", "pass", "machine.platform_ok");
  }
  return line("platform", "fail", "machine.platform_unsupported");
}

/** Null when the line does not apply: Intel Macs and Windows do not get that far. */
function cpuLine(facts: MachineFacts): CheckLine | null {
  if (facts.platform === "darwin") {
    // Apple silicon passes by definition.
    return facts.arch === "arm64" ? line("cpu", "pass", "machine.cpu_ok") : null;
  }
  if (facts.platform !== "linux") return null;
  const missing = facts.cpuInfo === null ? null : missingCpuFeatures(facts.arch, facts.cpuInfo);
  if (missing === null) return line("cpu", "warn", "machine.cpu_unknown");
  if (missing.length > 0) return line("cpu", "fail", "machine.cpu_missing", { missing: missing.join(", ") });
  return line("cpu", "pass", "machine.cpu_ok");
}

function ramLine(facts: MachineFacts): CheckLine {
  const total = facts.totalMemory;
  if (total < RAM_REFUSE_BELOW) return line("ram", "fail", "machine.ram_too_low", { total, minimum: RAM_REFUSE_BELOW });
  if (total < RAM_WARN_BELOW) return line("ram", "warn", "machine.ram_low", { total, recommended: RAM_WARN_BELOW });
  return line("ram", "pass", "machine.ram_ok", { total });
}

function diskLine(facts: MachineFacts): CheckLine {
  if (facts.freeDisk < RUN_FREE_DISK) {
    return line("disk", "warn", "machine.disk_low", { free: facts.freeDisk, needed: RUN_FREE_DISK });
  }
  return line("disk", "pass", "machine.disk_ok", { free: facts.freeDisk });
}

/** Only the driver is looked at here. Whether a container can use the card is decided when the engine is installed. */
function gpuLine(facts: MachineFacts): CheckLine | null {
  if (!gpuApplies(facts)) return null;
  if (facts.nvidia.driverAnswers) return line("gpu", "pass", "machine.gpu_nvidia", { count: facts.nvidia.gpus.length });
  return line("gpu", "pass", "machine.gpu_none");
}

/** The sentence that names the tool and its version, one code per tool. */
const RUNTIME_FOUND_CODES = {
  podman: "machine.runtime_found_podman",
  docker: "machine.runtime_found_docker",
  "apple-container": "machine.runtime_found_apple_container",
} as const satisfies Record<RuntimeId, MessageCode>;

function runtimeLine(facts: MachineFacts, chosen: RuntimeId | null): CheckLine | null {
  if (facts.platform !== "linux" && facts.platform !== "darwin") return null;
  const preferred = preferredRuntime(facts.runtimes, chosen);
  if (preferred === null) {
    // A tool that is installed but cannot be used is named with its own problem; "none" means nothing is installed.
    const broken = facts.runtimes.filter(
      (runtime) => runtime.problem !== null && runtime.problem.code !== "runtime.not_installed",
    );
    const named = broken.find((runtime) => runtime.id === chosen) ?? broken[0];
    if (named?.problem) return line("runtime", "warn", named.problem.code, named.problem.data);
    return line("runtime", "warn", "machine.runtime_none");
  }
  if (preferred.memoryCapEnforced === false) {
    return line("runtime", "warn", "machine.runtime_no_memory_cap", { runtime: preferred.id });
  }
  // A version that could not be read leaves the plain sentence.
  if (preferred.version === null) return line("runtime", "pass", "machine.runtime_found", { runtime: preferred.id });
  return line("runtime", "pass", RUNTIME_FOUND_CODES[preferred.id], { runtime: preferred.id, version: preferred.version });
}

export interface CheckOptions {
  /** The runtime the operator chose in settings, if any. */
  preferredRuntime?: RuntimeId | null;
  /** Milliseconds since the epoch. */
  now?: number;
}

/** Turns the facts into one line per check. Pure: the same facts give the same answer. */
export function checkMachine(facts: MachineFacts, options: CheckOptions = {}): MachineCheckView {
  const lines = [
    platformLine(facts),
    cpuLine(facts),
    ramLine(facts),
    diskLine(facts),
    gpuLine(facts),
    runtimeLine(facts, options.preferredRuntime ?? null),
  ].filter((candidate): candidate is CheckLine => candidate !== null);

  // A missing runtime does not stop the offer: a later ticket installs one.
  const blocking = lines.find(
    (candidate) => ["platform", "cpu", "ram"].includes(candidate.id) && candidate.result === "fail",
  );
  return {
    lines,
    localEngine: { offered: blocking === undefined, reason: blocking?.message ?? null },
    checkedAt: new Date(options.now ?? Date.now()).toISOString(),
  };
}
