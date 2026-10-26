import os from "node:os";
import { describeCommand, EXIT_NOT_FOUND, type CommandResult, type CommandRunner } from "../process/command-runner.ts";
import { defaultCaps, type Caps } from "../local-engine/caps.ts";
import { DEFAULT_STOP_TIMEOUT_SECONDS } from "./cli-runtime.ts";
import {
  asRecord,
  fail,
  notInstalled,
  ok,
  parseJson,
  unavailable,
  unusable,
  type ContainerRuntime,
  type ContainerSpec,
  type ContainerStatus,
  type PullProgress,
  type RuntimeDetection,
  type RuntimeResult,
} from "./runtime.ts";

const MIB = 1024 ** 2;

/**
 * Where Apple's installer puts the tool (section C of the runtime facts). It is
 * always called by this path and never found through PATH, so a program of the
 * same name elsewhere is never run, and a Mac app started from Finder, whose
 * PATH is short, finds it too.
 */
export const APPLE_TOOL = "/usr/local/bin/container";

/** The first line `container --version` prints: "container CLI version 1.6.1 (build: release, commit: 804209b)". */
const VERSION_LINE = /^container CLI version (\S+) \(build: [^,)]+, commit: [0-9a-f]+\)\s*$/;

/** The version in the tool's `--version` output, or null when the output is not the tool's version line. */
export function parseToolVersion(stdout: string): string | null {
  return VERSION_LINE.exec(stdout.split("\n")[0] ?? "")?.[1] ?? null;
}

/** Apple's tool runs Linux on Apple silicon only. The image is pulled for this platform, and run uses that copy. */
const PLATFORM = "linux/arm64";

const START_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 60_000;
/** A pull can print thousands of lines. Only the last ones are kept, because the failure is told at the end. */
const PULL_OUTPUT_LINES = 1000;

/** Any call fails like this when the tool's system service is off. */
const SERVICE_DOWN = /container system service has been started/i;
// Only whole phrases are matched. A bare "not found" or "denied" says nothing
// about what was not found or denied (a kernel, a folder), so it is not taken
// to mean a missing container or image.
/** "container not found: <id>" from inspect and "container with ID <id> not found" from the service (section C4). */
const NO_SUCH_CONTAINER = /container not found:|container with ID \S+ not found/i;
const MISSING_CONTAINER_LINE = /^(error: )?(notFound: )?"?container (not found:|with ID \S+ not found)/i;
const NOT_RUNNING = /container \S+ is not running/i;
// Section C has no text for a missing image. These two come from the recorded
// answers of the tool: its own message, and the registry's standard one.
const NO_SUCH_IMAGE = /image not found:/i;
const NOT_AT_REGISTRY = /manifest unknown/i;
const NAME_IN_USE = /container already exists/i;
const PORT_IN_USE = /address already in use|port .* (is )?(already )?(in use|allocated)|EADDRINUSE/i;

/**
 * The command line that starts the container. The memory and CPU flags are
 * always sent: the tool's VM gets only 1 GiB when the flag is missing, which
 * is too little for the engine. A cap the spec leaves out is filled from
 * `defaults`, the same numbers the engine manager would give. The tool has no
 * restart policy, so there is no restart flag. The tool's list of flags for
 * `run` has no platform flag, so none is sent: `spec.platform` is not used,
 * and the image is the arm64 copy that the pull stored. A read-only mount
 * ends in ":ro", the one mount option the tool reads (1.6.1: the volume
 * parser keeps the third part as options, and the folder is shared into the
 * VM read-only when they hold "ro").
 */
export function runArgv(spec: ContainerSpec, defaults: Caps = hostDefaults()): string[] {
  const { hostAddress, hostPort, containerPort } = spec.publish;
  const memoryMib = Math.max(1, Math.ceil((spec.memoryBytes ?? defaults.memoryBytes) / MIB));
  return [
    APPLE_TOOL,
    "run",
    "-d",
    "--name",
    spec.name,
    "--memory",
    `${memoryMib}M`,
    "--cpus",
    String(spec.cpus ?? defaults.cpus),
    "-p",
    `${hostAddress}:${hostPort}:${containerPort}`,
    ...spec.mounts.flatMap((mount) => ["-v", `${mount.hostPath}:${mount.containerPath}${mount.readOnly ? ":ro" : ""}`]),
    spec.image,
    ...spec.args,
  ];
}

function hostDefaults(): Caps {
  return defaultCaps(os.totalmem(), os.availableParallelism());
}

/**
 * Turns the plain progress lines of `container image pull` into progress.
 * Plain output has one line per render, such as
 * "[1/2] Fetching image 31% (2 of 7 blobs, ...)" and then
 * "[2/2] Unpacking image 52% (214 of 412 entries)". Those lines do not say
 * which blobs are layers and which are the image's config and manifests, so
 * the counts are reported as they are and the page calls them parts.
 * Unpacking is the writing phase.
 */
export function applePullParser(): (line: string) => PullProgress | null {
  let layersDone: number | null = null;
  let layersTotal: number | null = null;
  let last = "";
  return (line) => {
    const phase = /^\[\d+\/\d+\]\s+(Fetching|Unpacking)\b/.exec(line)?.[1];
    if (phase === undefined) return null;
    const counts = /\((\d+) of (\d+) blobs\b/.exec(line);
    if (counts !== null) {
      layersDone = Number(counts[1]);
      layersTotal = Number(counts[2]);
    }
    const progress: PullProgress =
      phase === "Fetching"
        ? { layersDone, layersTotal, phase: "downloading" }
        : { layersDone: layersTotal, layersTotal, phase: "writing" };
    const key = JSON.stringify(progress);
    if (key === last) return null;
    last = key;
    return progress;
  };
}

export interface AppleContainerOptions {
  log?: (line: string) => void;
  /** The memory and CPUs to send when the spec names none. Default: what the engine manager gives on this computer. */
  defaults?: () => Caps;
}

/** Apple's container tool. Its VMs always have a memory size, so a cap is always enforced. */
export function appleContainerRuntime(runner: CommandRunner, options: AppleContainerOptions = {}): ContainerRuntime {
  const log = options.log ?? (() => {});
  const defaults = options.defaults ?? hostDefaults;

  async function run(argv: string[], timeoutMs?: number): Promise<CommandResult> {
    log(describeCommand(argv));
    return runner.run(argv, timeoutMs === undefined ? {} : { timeoutMs });
  }

  const text = (result: CommandResult) => `${result.stderr}\n${result.stdout}`;

  function failed(operation: string, exitCode: number): RuntimeResult<never> {
    return fail("runtime.command_failed", { operation, exitCode });
  }

  /** What every call says when the system service is off. */
  function serviceDown(result: CommandResult): RuntimeResult<never> | null {
    return SERVICE_DOWN.test(text(result)) ? fail("runtime.apple_not_started") : null;
  }

  async function detect(): Promise<RuntimeDetection> {
    // `--version` is the safest question: it needs no service and no network, so
    // it tells that the tool is installed even when its service never started.
    const version = await runner.run([APPLE_TOOL, "--version"]);
    if (version.exitCode === EXIT_NOT_FOUND) return notInstalled("apple-container");
    const installed = version.exitCode === 0 ? parseToolVersion(version.stdout) : null;
    if (installed === null) return unusable("apple-container");

    // The status output is reconstructed from the tool's source and was not
    // captured. When the service is not running it prints its status and exits
    // 1. So only a plain "running" with exit 0 counts as running, and any other
    // answer from a tool that answered `--version` means the service is not up,
    // which the Mac flow fixes by starting it. It is never "unusable".
    const status = await runner.run([APPLE_TOOL, "system", "status", "--format", "json"]);
    const state = asRecord(parseJson(status.stdout))?.status;
    if (status.exitCode !== 0 || state !== "running") {
      return {
        ...unavailable("apple-container", { code: "runtime.apple_not_started", data: {} }),
        version: installed,
      };
    }
    return {
      id: "apple-container",
      available: true,
      version: installed,
      memoryCapEnforced: true,
      cpuCapEnforced: true,
      storagePath: null,
      problem: null,
    };
  }

  return {
    id: "apple-container",
    detect,

    async pull(image, pullOptions = {}) {
      const argv = [APPLE_TOOL, "image", "pull", "--platform", pullOptions.platform ?? PLATFORM, "--progress", "plain", image];
      log(describeCommand(argv));
      const parse = applePullParser();
      const kept: string[] = [];
      const result = await runner.stream(argv, {
        signal: pullOptions.signal,
        onLine: (line) => {
          kept.push(line);
          if (kept.length > PULL_OUTPUT_LINES) kept.shift();
          const progress = parse(line);
          if (progress !== null) pullOptions.onProgress?.(progress);
        },
      });
      if (result.exitCode === 0) return ok(undefined);
      const output = kept.join("\n");
      if (SERVICE_DOWN.test(output)) return fail("runtime.apple_not_started");
      if (result.exitCode !== EXIT_NOT_FOUND && NOT_AT_REGISTRY.test(output)) return fail("runtime.image_not_found");
      return fail("runtime.pull_failed", { exitCode: result.exitCode });
    },

    async start(spec) {
      const result = await run(runArgv(spec, defaults()), START_TIMEOUT_MS);
      if (result.exitCode === 0) {
        // The ID the tool prints is the name.
        const containerId = result.stdout.split("\n").find((line) => line.trim() !== "")?.trim();
        if (containerId !== undefined) return ok({ containerId });
        // Exit 0 means this call made the container: a name that was taken
        // fails with "container already exists". With no ID printed it cannot
        // be used, so the one this call made is removed.
        await run([APPLE_TOOL, "delete", "--force", spec.name], REMOVE_TIMEOUT_MS);
        return fail("runtime.start_failed", { exitCode: 0 });
      }
      // A failed run is never followed by a delete. Nothing in its output shows
      // that this call made a container, and a container under the name may be
      // someone else's. The engine manager clears a leftover of its own before it starts.
      const down = serviceDown(result);
      if (down !== null) return down;
      const output = text(result);
      if (NAME_IN_USE.test(output)) return fail("runtime.name_in_use", { name: spec.name });
      if (PORT_IN_USE.test(output)) return fail("runtime.port_in_use", { port: spec.publish.hostPort });
      if (NO_SUCH_IMAGE.test(output) || NOT_AT_REGISTRY.test(output)) return fail("runtime.image_not_found");
      return fail("runtime.start_failed", { exitCode: result.exitCode });
    },

    // The one-off container is the test run inside the graphics card package,
    // and only the Linux NVIDIA package has one. Apple's tool gives its VMs no
    // graphics card, so no Mac package asks for it, and no flags are guessed.
    async runOnce() {
      return fail("runtime.command_failed", { operation: "run_once", exitCode: null });
    },

    async stop(name, timeoutSeconds) {
      // The tool waits 5 seconds by default. A caller that names a time gets it.
      const argv = [APPLE_TOOL, "stop", ...(timeoutSeconds === undefined ? [] : ["-t", String(timeoutSeconds)]), name];
      const result = await run(argv, ((timeoutSeconds ?? DEFAULT_STOP_TIMEOUT_SECONDS) + 30) * 1000);
      if (result.exitCode === 0) return ok(undefined);
      // With the service off no VM runs, which is what the caller wanted.
      if (serviceDown(result) !== null) return ok(undefined);
      // A container that is gone or already stopped is what the caller wanted too.
      if (NO_SUCH_CONTAINER.test(result.stderr) || NOT_RUNNING.test(result.stderr)) return ok(undefined);
      return failed("stop", result.exitCode);
    },

    async status(name) {
      const result = await run([APPLE_TOOL, "inspect", name]);
      if (result.exitCode !== 0) {
        const down = serviceDown(result);
        if (down !== null) return down;
        return NO_SUCH_CONTAINER.test(text(result))
          ? ok({ state: "missing", exitCode: null, oomKilled: null })
          : failed("status", result.exitCode);
      }
      const parsed = parseJson(result.stdout);
      if (Array.isArray(parsed) && parsed.length === 0) return ok({ state: "missing", exitCode: null, oomKilled: null });
      return readStatus(Array.isArray(parsed) ? parsed[0] : parsed, result.exitCode);
    },

    async logs(name, logOptions) {
      const argv = [
        APPLE_TOOL,
        "logs",
        ...(logOptions.follow ? ["-f"] : []),
        ...(logOptions.tail === undefined ? [] : ["-n", String(logOptions.tail)]),
        name,
      ];
      log(describeCommand(argv));
      // The tool reports a missing container on the stream the container's own
      // lines use, so that one message is kept back from the caller.
      let missing = false;
      const result = await runner.stream(argv, {
        signal: logOptions.signal,
        onLine: (line) => {
          if (MISSING_CONTAINER_LINE.test(line)) {
            missing = true;
            return;
          }
          logOptions.onLine(line);
        },
      });
      if (result.exitCode === 0 || missing || logOptions.signal?.aborted) return ok(undefined);
      return failed("logs", result.exitCode);
    },

    async remove(name) {
      const result = await run([APPLE_TOOL, "delete", "--force", name], REMOVE_TIMEOUT_MS);
      if (result.exitCode === 0) return ok(undefined);
      const down = serviceDown(result);
      if (down !== null) return down;
      if (NO_SUCH_CONTAINER.test(result.stderr)) return ok(undefined);
      return failed("remove", result.exitCode);
    },

    async removeImage(image) {
      const result = await run([APPLE_TOOL, "image", "delete", image], REMOVE_TIMEOUT_MS);
      if (result.exitCode === 0) return ok(undefined);
      const down = serviceDown(result);
      if (down !== null) return down;
      if (NO_SUCH_IMAGE.test(result.stderr)) return ok(undefined);
      return failed("removeImage", result.exitCode);
    },
  };
}

/**
 * Reads one object of `container inspect`. The state sits in `status.state`
 * and is one of running, stopped, stopping or unknown (section C5). "stopping"
 * counts as stopped, and so does "unknown": the manager then removes the
 * container and starts anew, which is also what a VM in an unknown state
 * needs. The output has no exit code of the container.
 */
function readStatus(entry: unknown, exitCode: number): RuntimeResult<ContainerStatus> {
  const state = asRecord(asRecord(entry)?.status)?.state;
  if (state === "running") return ok({ state: "running", exitCode: null, oomKilled: null });
  if (state === "stopped" || state === "stopping" || state === "unknown") {
    return ok({ state: "stopped", exitCode: null, oomKilled: null });
  }
  return fail("runtime.command_failed", { operation: "status", exitCode });
}
