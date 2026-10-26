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

/** Apple's tool runs Linux on Apple silicon only. */
const PLATFORM = "linux/arm64";

const START_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 60_000;
/** A pull can print thousands of lines. Only the last ones are kept, because the failure is told at the end. */
const PULL_OUTPUT_LINES = 1000;

/** Any call fails like this when the tool's system service is off. */
const SERVICE_DOWN = /container system service has been started/i;
/** "container not found: <id>" from inspect and "container with ID <id> not found" from the service. */
const NO_SUCH_CONTAINER = /container not found|container with ID .* not found/i;
const MISSING_CONTAINER_LINE = /^(error: )?(notFound: )?"?container (not found|with ID .* not found)/i;
const NOT_RUNNING = /container .* is not running/i;
const NO_SUCH_IMAGE = /image not found|image .* not found/i;
const NOT_AT_REGISTRY = /manifest unknown|not ?found|denied|unauthorized|no such (repository|manifest)/i;
const NAME_IN_USE = /container already exists/i;
const PORT_IN_USE = /address already in use|port .* (is )?(already )?(in use|allocated)|EADDRINUSE/i;

/**
 * The command line that starts the container. The memory and CPU flags are
 * always sent: the tool's VM gets only 1 GiB when the flag is missing, which
 * is too little for the engine. A cap the spec leaves out is filled from
 * `defaults`, the same numbers the engine manager would give. The tool has no
 * restart policy, so there is no restart flag, and it makes the VM it needs
 * for a Linux arm64 image by itself. It is always "enforced", so the
 * detection is not read.
 */
export function runArgv(spec: ContainerSpec, _detection: RuntimeDetection, defaults: Caps = hostDefaults()): string[] {
  const { hostAddress, hostPort, containerPort } = spec.publish;
  const memoryMib = Math.max(1, Math.ceil((spec.memoryBytes ?? defaults.memoryBytes) / MIB));
  return [
    "container",
    "run",
    "-d",
    "--name",
    spec.name,
    "--platform",
    spec.platform ?? PLATFORM,
    "--memory",
    `${memoryMib}M`,
    "--cpus",
    String(spec.cpus ?? defaults.cpus),
    "-p",
    `${hostAddress}:${hostPort}:${containerPort}`,
    ...spec.mounts.flatMap((mount) => ["-v", `${mount.hostPath}:${mount.containerPath}`]),
    spec.image,
    ...spec.args,
  ];
}

/** What the tool is taken to be when a start does not ask it again: caps are always enforced. */
const ASSUMED: RuntimeDetection = {
  id: "apple-container",
  available: true,
  version: null,
  memoryCapEnforced: true,
  cpuCapEnforced: true,
  storagePath: null,
  problem: null,
};

function hostDefaults(): Caps {
  return defaultCaps(os.totalmem(), os.availableParallelism());
}

/**
 * Turns the plain progress lines of `container image pull` into progress.
 * Plain output has one line per render, such as
 * "[1/2] Fetching image 31% (2 of 7 blobs, ...)" and then
 * "[2/2] Unpacking image 52% (214 of 412 entries)". The blob counts are the
 * layer counts; unpacking is the writing phase.
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
      cpuCapEnforced: true,
      storagePath: null,
      problem: null,
    };
  }

  return {
    id: "apple-container",
    detect,

    async pull(image, pullOptions = {}) {
      const argv = ["container", "image", "pull", "--platform", pullOptions.platform ?? PLATFORM, "--progress", "plain", image];
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
      const result = await run(runArgv(spec, ASSUMED, defaults()), START_TIMEOUT_MS);
      if (result.exitCode === 0) {
        // The ID the tool prints is the name.
        const containerId = result.stdout.split("\n").find((line) => line.trim() !== "")?.trim();
        if (containerId !== undefined) return ok({ containerId });
        // No ID is no proof that nothing was made, and the name is ours.
        await run(["container", "delete", "--force", spec.name], REMOVE_TIMEOUT_MS);
        return fail("runtime.start_failed", { exitCode: 0 });
      }
      const down = serviceDown(result);
      if (down !== null) return down;
      const output = text(result);
      // A name that is in use belongs to someone else's container: leave it.
      if (NAME_IN_USE.test(output)) return fail("runtime.name_in_use", { name: spec.name });
      // Any other failure may have left a half-made container under our name.
      await run(["container", "delete", "--force", spec.name], REMOVE_TIMEOUT_MS);
      if (PORT_IN_USE.test(output)) return fail("runtime.port_in_use", { port: spec.publish.hostPort });
      if (NO_SUCH_IMAGE.test(output) || NOT_AT_REGISTRY.test(output)) return fail("runtime.image_not_found");
      return fail("runtime.start_failed", { exitCode: result.exitCode });
    },

    async stop(name, timeoutSeconds) {
      // The tool waits 5 seconds by default. A caller that names a time gets it.
      const argv = ["container", "stop", ...(timeoutSeconds === undefined ? [] : ["-t", String(timeoutSeconds)]), name];
      const result = await run(argv, ((timeoutSeconds ?? DEFAULT_STOP_TIMEOUT_SECONDS) + 30) * 1000);
      if (result.exitCode === 0) return ok(undefined);
      // With the service off no VM runs, which is what the caller wanted.
      if (serviceDown(result) !== null) return ok(undefined);
      // A container that is gone or already stopped is what the caller wanted too.
      if (NO_SUCH_CONTAINER.test(result.stderr) || NOT_RUNNING.test(result.stderr)) return ok(undefined);
      return failed("stop", result.exitCode);
    },

    async status(name) {
      const result = await run(["container", "inspect", name]);
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
        "container",
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
      const result = await run(["container", "delete", "--force", name], REMOVE_TIMEOUT_MS);
      if (result.exitCode === 0) return ok(undefined);
      const down = serviceDown(result);
      if (down !== null) return down;
      if (NO_SUCH_CONTAINER.test(result.stderr)) return ok(undefined);
      return failed("remove", result.exitCode);
    },

    async removeImage(image) {
      const result = await run(["container", "image", "delete", image], REMOVE_TIMEOUT_MS);
      if (result.exitCode === 0) return ok(undefined);
      const down = serviceDown(result);
      if (down !== null) return down;
      if (NO_SUCH_IMAGE.test(result.stderr)) return ok(undefined);
      return failed("removeImage", result.exitCode);
    },
  };
}

/**
 * Reads one object of `container inspect`. The state sits in `status.state`;
 * a plain string in `status` is read too. "stopping" counts as stopped, and
 * so does "unknown": the manager then removes the container and starts anew,
 * which is also what a VM in an unknown state needs.
 */
function readStatus(entry: unknown, exitCode: number): RuntimeResult<ContainerStatus> {
  const object = asRecord(entry);
  const status = object?.status;
  const state = typeof status === "string" ? status : asRecord(status)?.state;
  if (state === "running") return ok({ state: "running", exitCode: null, oomKilled: null });
  if (state === "stopped" || state === "stopping" || state === "unknown") {
    const code = asRecord(status)?.exitCode;
    return ok({ state: "stopped", exitCode: typeof code === "number" ? code : null, oomKilled: null });
  }
  return fail("runtime.command_failed", { operation: "status", exitCode });
}
