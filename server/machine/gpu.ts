import type { ApiError } from "../../shared/api-error.ts";
import type { GpuView, RuntimeId } from "../../shared/api-types.ts";
import type { CommandRunner } from "../process/command-runner.ts";
import { asRecord, DETECT_TIMEOUT_MS, parseJson } from "../runtimes/runtime.ts";

/**
 * Where the operator reads how to set up the NVIDIA Container Toolkit. It is
 * shown as a plain link. Nothing is fetched from it.
 */
export const NVIDIA_TOOLKIT_GUIDE_URL =
  "https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html";

/** The device name that stands for every graphics card in Podman's list. */
export const CDI_ALL_DEVICES = "nvidia.com/gpu=all";

/** Seconds are not enough for the first run of a container with the toolkit's hook; the check waits this long. */
export const IN_IMAGE_CHECK_TIMEOUT_MS = 120_000;

/** The lines of `nvidia-smi -L` that name a card. */
export function parseGpuListing(stdout: string): string[] {
  return stdout.split("\n").filter((line) => /^GPU \d+:/.test(line));
}

/** What is known about the graphics card before anything is downloaded (checks a and b). */
export type GpuPrecheck =
  /** Not Linux on an Intel or AMD processor, or no container tool to ask: no command was run. */
  | { state: "not_checked" }
  /** The NVIDIA driver does not answer. Most computers have no NVIDIA card. */
  | { state: "no_driver" }
  /** The driver answers, but the container tool cannot hand the card to a container. */
  | { state: "no_passthrough"; runtime: RuntimeId }
  | {
      state: "ready";
      runtime: RuntimeId;
      gpus: number;
      /** Where the passthrough was seen: the runtimes in `docker info`, or the device list of `nvidia-ctk cdi list`. */
      passthrough: "docker_runtimes" | "cdi_devices";
    };

export const NOT_CHECKED: GpuPrecheck = { state: "not_checked" };

/** The GPU package exists for Linux on an Intel or AMD processor only. */
export function gpuApplies(facts: { platform: string; arch: string }): boolean {
  return facts.platform === "linux" && facts.arch === "x64";
}

async function dockerHasNvidiaRuntime(runner: CommandRunner): Promise<boolean> {
  const info = await runner.run(["docker", "info", "--format", "json"], { timeoutMs: DETECT_TIMEOUT_MS });
  if (info.exitCode !== 0) return false;
  const runtimes = asRecord(asRecord(parseJson(info.stdout))?.Runtimes);
  return runtimes !== undefined && "nvidia" in runtimes;
}

async function podmanHasCdiDevice(runner: CommandRunner): Promise<boolean> {
  const list = await runner.run(["nvidia-ctk", "cdi", "list"]);
  return list.exitCode === 0 && list.stdout.split("\n").some((line) => line.trim() === CDI_ALL_DEVICES);
}

/**
 * Checks a and b: the driver answers and the container tool can pass the card
 * through. Runs nothing unless the computer can use the GPU package at all.
 */
export async function precheckGpu(
  runner: CommandRunner,
  facts: { platform: string; arch: string },
  runtime: RuntimeId | null,
): Promise<GpuPrecheck> {
  if (!gpuApplies(facts) || (runtime !== "docker" && runtime !== "podman")) return NOT_CHECKED;
  const listing = await runner.run(["nvidia-smi", "-L"]);
  const gpus = listing.exitCode === 0 ? parseGpuListing(listing.stdout) : [];
  if (gpus.length === 0) return { state: "no_driver" };

  const seen = runtime === "docker" ? await dockerHasNvidiaRuntime(runner) : await podmanHasCdiDevice(runner);
  if (!seen) return { state: "no_passthrough", runtime };
  return {
    state: "ready",
    runtime,
    gpus: gpus.length,
    passthrough: runtime === "docker" ? "docker_runtimes" : "cdi_devices",
  };
}

/** Check c failed: the listing inside the pulled image did not work. */
export function inImageFailed(): ApiError {
  return { code: "gpu.in_image_failed", data: { guideUrl: NVIDIA_TOOLKIT_GUIDE_URL } };
}

/**
 * What the operator is told about the graphics card, from the checks that ran
 * before the download. A computer with no NVIDIA card gets no reason: that is
 * the usual case and needs no explanation.
 */
export function describeGpu(
  precheck: GpuPrecheck | undefined,
  options: { forceCpu: boolean; manifestHasGpuPackage: boolean },
): GpuView {
  const none: GpuView = { state: "not_used", reason: null, guideUrl: null };
  if (precheck === undefined || precheck.state === "not_checked") return { ...none, state: "not_checked" };
  if (precheck.state === "no_driver") return none;
  if (options.forceCpu) return { ...none, reason: { code: "gpu.forced_cpu", data: {} } };
  if (precheck.state === "no_passthrough") {
    return {
      state: "not_used",
      reason: { code: "gpu.no_passthrough", data: { runtime: precheck.runtime, guideUrl: NVIDIA_TOOLKIT_GUIDE_URL } },
      guideUrl: NVIDIA_TOOLKIT_GUIDE_URL,
    };
  }
  if (!options.manifestHasGpuPackage) return none;
  return { state: "used", reason: null, guideUrl: null };
}

/** True when checks a and b allow the GPU package and the operator did not rule it out. */
export function mayUseGpuPackage(precheck: GpuPrecheck | undefined, forceCpu: boolean): boolean {
  return precheck?.state === "ready" && !forceCpu;
}
