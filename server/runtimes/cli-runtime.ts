import { describeCommand, EXIT_NOT_FOUND, type CommandResult, type CommandRunner } from "../process/command-runner.ts";
import {
  asRecord,
  fail,
  ok,
  parseJson,
  type ContainerRuntime,
  type ContainerSpec,
  type ContainerStatus,
  type PullProgress,
  type RuntimeDetection,
  type RuntimeId,
  type RuntimeResult,
} from "./runtime.ts";

/** Turns one line of a pull's output into progress, or null when the line says nothing new. */
export type PullLineParser = (line: string) => PullProgress | null;

export interface CliRuntimeTool {
  id: Extract<RuntimeId, "podman" | "docker">;
  detect(): Promise<RuntimeDetection>;
  /** The command that reads one container's state. */
  inspectArgv(name: string): string[];
  /** A new parser for each pull, because it keeps count. */
  pullParser(): PullLineParser;
}

export const DEFAULT_STOP_TIMEOUT_SECONDS = 30;

/** Creating a container can take a while on a busy disk. */
const START_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 60_000;
/** A pull can print thousands of lines. Only the last ones are kept, because the failure is told at the end. */
const PULL_OUTPUT_LINES = 1000;

const NO_SUCH_CONTAINER = /no such container|no container with name or ID|no such object/i;
const NO_SUCH_IMAGE = /image not known|no such image/i;
const NOT_AT_REGISTRY =
  /manifest unknown|repository does not exist|name unknown|pull access denied|requested access to the resource is denied/i;
/** "not found" alone also says a program is missing inside a container, so only a pull may rely on it. */
const PULL_NOT_FOUND = /not found/i;
const PORT_IN_USE = /address already in use|port is already allocated/i;
const NAME_IN_USE = /container name .* is already in use/i;

const MISSING_CONTAINER_LINE = /^(error( response from daemon)?: )?(no such container|no container with name or ID)/i;

const STOPPED_STATES = new Set(["exited", "stopped", "created", "dead", "removing", "stopping"]);

/** What Podman and Docker share: the same commands, answers and mistakes, apart from a few words. */
export function cliRuntime(
  tool: CliRuntimeTool,
  runner: CommandRunner,
  runArgv: (spec: ContainerSpec, detection: RuntimeDetection) => string[],
  log: (line: string) => void = () => {},
): ContainerRuntime {
  const binary: string = tool.id;

  async function run(argv: string[], timeoutMs?: number): Promise<CommandResult> {
    log(describeCommand(argv));
    return runner.run(argv, timeoutMs === undefined ? {} : { timeoutMs });
  }

  function failed(operation: string, exitCode: number): RuntimeResult<never> {
    return fail("runtime.command_failed", { operation, exitCode });
  }

  return {
    id: tool.id,
    detect: () => tool.detect(),

    async pull(image, options = {}) {
      const argv = [binary, "pull", ...(options.platform ? ["--platform", options.platform] : []), image];
      log(describeCommand(argv));
      const parse = tool.pullParser();
      const text: string[] = [];
      const result = await runner.stream(argv, {
        signal: options.signal,
        onLine: (line) => {
          text.push(line);
          if (text.length > PULL_OUTPUT_LINES) text.shift();
          const progress = parse(line);
          if (progress !== null) options.onProgress?.(progress);
        },
      });
      if (result.exitCode === 0) return ok(undefined);
      const output = text.join("\n");
      if (result.exitCode !== EXIT_NOT_FOUND && (NOT_AT_REGISTRY.test(output) || PULL_NOT_FOUND.test(output))) {
        return fail("runtime.image_not_found");
      }
      return fail("runtime.pull_failed", { exitCode: result.exitCode });
    },

    async start(spec) {
      const detection = await tool.detect();
      const result = await run(runArgv(spec, detection), START_TIMEOUT_MS);
      if (result.exitCode === 0) {
        const containerId = result.stdout.split("\n").find((line) => line.trim() !== "")?.trim();
        if (containerId !== undefined) return ok({ containerId });
        // No ID is no proof that nothing was made, and the name is ours.
        await run([binary, "rm", "-f", spec.name], REMOVE_TIMEOUT_MS);
        return fail("runtime.start_failed", { exitCode: 0 });
      }
      const text = `${result.stderr}\n${result.stdout}`;
      // Both tools may have created the container before the start failed. The
      // name is ours, so it is cleared away, or the next try would meet it.
      // A name that is in use belongs to someone else's container: leave it.
      if (PORT_IN_USE.test(text)) {
        await run([binary, "rm", "-f", spec.name], REMOVE_TIMEOUT_MS);
        return fail("runtime.port_in_use", { port: spec.publish.hostPort });
      }
      if (NAME_IN_USE.test(text)) return fail("runtime.name_in_use", { name: spec.name });
      await run([binary, "rm", "-f", spec.name], REMOVE_TIMEOUT_MS);
      if (NO_SUCH_IMAGE.test(text) || NOT_AT_REGISTRY.test(text)) return fail("runtime.image_not_found");
      return fail("runtime.start_failed", { exitCode: result.exitCode });
    },

    async stop(name, timeoutSeconds = DEFAULT_STOP_TIMEOUT_SECONDS) {
      const result = await run([binary, "stop", "-t", String(timeoutSeconds), name], (timeoutSeconds + 30) * 1000);
      if (result.exitCode === 0 || NO_SUCH_CONTAINER.test(result.stderr)) return ok(undefined);
      return failed("stop", result.exitCode);
    },

    async status(name) {
      const result = await run(tool.inspectArgv(name));
      if (result.exitCode !== 0) {
        const missing =
          NO_SUCH_CONTAINER.test(result.stderr) || (result.exitCode === 125 && result.stdout.trim() === "[]");
        return missing ? ok({ state: "missing", exitCode: null, oomKilled: null }) : failed("status", result.exitCode);
      }
      const parsed = parseJson(result.stdout);
      if (Array.isArray(parsed) && parsed.length === 0) {
        return ok({ state: "missing", exitCode: null, oomKilled: null });
      }
      const state = asRecord(asRecord(Array.isArray(parsed) ? parsed[0] : parsed)?.State);
      if (typeof state?.Status !== "string") return failed("status", result.exitCode);
      return readState(state, result.exitCode);
    },

    async logs(name, options) {
      const argv = [
        binary,
        "logs",
        ...(options.follow ? ["-f"] : []),
        ...(options.tail === undefined ? [] : ["--tail", String(options.tail)]),
        name,
      ];
      log(describeCommand(argv));
      // The tool reports a missing container on the stream the container's own
      // lines use, so that one message is kept back from the caller.
      let missing = false;
      const result = await runner.stream(argv, {
        signal: options.signal,
        onLine: (line) => {
          if (MISSING_CONTAINER_LINE.test(line)) {
            missing = true;
            return;
          }
          options.onLine(line);
        },
      });
      if (result.exitCode === 0 || missing || options.signal?.aborted) return ok(undefined);
      return failed("logs", result.exitCode);
    },

    async remove(name) {
      const result = await run([binary, "rm", "-f", name], REMOVE_TIMEOUT_MS);
      if (result.exitCode === 0 || NO_SUCH_CONTAINER.test(result.stderr)) return ok(undefined);
      return failed("remove", result.exitCode);
    },

    async removeImage(image) {
      const result = await run([binary, "rmi", image], REMOVE_TIMEOUT_MS);
      if (result.exitCode === 0 || NO_SUCH_IMAGE.test(result.stderr)) return ok(undefined);
      return failed("removeImage", result.exitCode);
    },
  };
}

function readState(state: Record<string, unknown>, exitCode: number): RuntimeResult<ContainerStatus> {
  const oomKilled = typeof state.OOMKilled === "boolean" ? state.OOMKilled : null;
  if (state.Status === "running") return ok({ state: "running", exitCode: null, oomKilled });
  if (typeof state.Status === "string" && STOPPED_STATES.has(state.Status)) {
    // A container that was created and never started has no exit code to report.
    const code = state.Status === "created" || typeof state.ExitCode !== "number" ? null : state.ExitCode;
    return ok({ state: "stopped", exitCode: code, oomKilled });
  }
  return fail("runtime.command_failed", { operation: "status", exitCode });
}

/** The argument list the two tools share, up to and including the image name. */
export function sharedRunArgs(
  binary: string,
  spec: ContainerSpec,
  options: { mountSuffix: string; memoryCap: boolean; cpuCap: boolean },
): string[] {
  const { hostAddress, hostPort, containerPort } = spec.publish;
  return [
    binary,
    "run",
    "-d",
    // Starting never pulls. The pull is its own step with its own progress and retries.
    "--pull=never",
    "--name",
    spec.name,
    "-p",
    `${hostAddress}:${hostPort}:${containerPort}`,
    ...spec.mounts.flatMap((mount) => ["-v", `${mount.hostPath}:${mount.containerPath}${options.mountSuffix}`]),
    ...(options.memoryCap && spec.memoryBytes !== null ? ["--memory", `${spec.memoryBytes}b`] : []),
    ...(options.cpuCap && spec.cpus !== null ? ["--cpus", String(spec.cpus)] : []),
    ...(spec.platform === null ? [] : ["--platform", spec.platform]),
    spec.image,
    ...spec.args,
  ];
}
