import type { DownloadedImage } from "../images/image-download.ts";
import { describeCommand, type CommandResult, type CommandRunner } from "../process/command-runner.ts";
import {
  asRecord,
  fail,
  ok,
  parseJson,
  type ContainerRuntime,
  type ContainerSpec,
  type ContainerStatus,
  type OneOffSpec,
  type RuntimeDetection,
  type RuntimeId,
  type RuntimeResult,
} from "./runtime.ts";

/** What a tool's load needs from the adapter: a streamed command with optional input, and a plain one. */
export interface LoadContext {
  signal?: AbortSignal;
  stream(argv: string[], stdin?: ReadableStream<Uint8Array>): Promise<CommandResult>;
  run(argv: string[]): Promise<CommandResult>;
}

export interface CliRuntimeTool {
  id: Extract<RuntimeId, "podman" | "docker">;
  detect(): Promise<RuntimeDetection>;
  /** The command that reads one container's state. */
  inspectArgv(name: string): string[];
  /** See ContainerRuntime.loadCopies. */
  loadCopies: number;
  /** Runs the tool's load of a downloaded image, and whatever must follow it for the image to carry its name. */
  load(image: DownloadedImage, context: LoadContext): Promise<CommandResult>;
  /** The flags that hand the NVIDIA graphics card to a container. */
  gpuFlags: readonly string[];
}

export const DEFAULT_STOP_TIMEOUT_SECONDS = 30;

/** Creating a container can take a while on a busy disk. */
const START_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 60_000;
/** A load can print many lines. Only the last ones are kept, because the failure is told at the end. */
const LOAD_OUTPUT_LINES = 200;

const NO_SUCH_CONTAINER = /no such container|no container with name or ID|no such object/i;
const NO_SUCH_IMAGE = /image not known|no such image/i;
const NOT_AT_REGISTRY =
  /manifest unknown|repository does not exist|name unknown|pull access denied|requested access to the resource is denied/i;
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

    loadCopies: tool.loadCopies,

    async load(image, options = {}) {
      const kept: string[] = [];
      const result = await tool.load(image, {
        signal: options.signal,
        stream: (argv, stdin) => {
          log(describeCommand(argv));
          return runner.stream(argv, {
            signal: options.signal,
            ...(stdin === undefined ? {} : { stdin }),
            onLine: (line) => {
              kept.push(line);
              if (kept.length > LOAD_OUTPUT_LINES) kept.shift();
            },
          });
        },
        run: (argv) => run(argv, REMOVE_TIMEOUT_MS),
      });
      if (result.exitCode === 0) return ok(undefined);
      if (options.signal?.aborted) return fail("download.cancelled");
      log(`The load ended with exit code ${result.exitCode}: ${kept.slice(-5).join(" / ")}`);
      return fail("runtime.load_failed", { exitCode: result.exitCode });
    },

    async verifyImage(image) {
      const result = await run([binary, "image", "inspect", image.name]);
      const parsed = parseJson(result.stdout);
      const entry = asRecord(Array.isArray(parsed) ? parsed[0] : undefined);
      if (result.exitCode !== 0 || entry === undefined || typeof entry.Id !== "string") {
        return fail("runtime.image_not_verified", { name: image.name });
      }
      // Podman gives the ID without its algorithm; it reads the full form too.
      const id = entry.Id.startsWith("sha256:") ? entry.Id : `sha256:${entry.Id}`;
      // The ID is the config digest in Podman and in Docker's classic store,
      // and the manifest digest in Docker's containerd store. Podman also
      // keeps the manifest digest it was given.
      const matches = id === image.config.digest || id === image.manifest.digest || entry.Digest === image.manifest.digest;
      if (!matches) return fail("runtime.image_not_verified", { name: image.name });
      return ok(id);
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

    async runOnce(spec, timeoutMs, signal) {
      const argv = oneOffArgv(binary, spec, tool.gpuFlags);
      // A check container left by a crash would make this one fail on its name.
      await run([binary, "rm", "-f", spec.name], REMOVE_TIMEOUT_MS);
      log(describeCommand(argv));
      const out: string[] = [];
      const err: string[] = [];
      const result = await runner.stream(argv, {
        signal,
        timeoutMs,
        onLine: (line, from) => (from === "stdout" ? out : err).push(`${line}\n`),
      });
      // Killing the tool's client can leave the container behind, so it is removed by name.
      if (result.exitCode !== 0 || signal?.aborted) await run([binary, "rm", "-f", spec.name], REMOVE_TIMEOUT_MS);
      return ok({ exitCode: result.exitCode, stdout: out.join(""), stderr: err.join("") });
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
  options: { selinuxLabel: boolean; memoryCap: boolean; cpuCap: boolean; gpuFlags: readonly string[] },
): string[] {
  const { hostAddress, hostPort, containerPort } = spec.publish;
  return [
    binary,
    "run",
    "-d",
    // Starting never pulls. The image comes from aidm-ui's own download and the tool's load (ADR 0005).
    "--pull=never",
    "--name",
    spec.name,
    "-p",
    `${hostAddress}:${hostPort}:${containerPort}`,
    ...spec.mounts.flatMap((mount) => {
      const mountOptions = [...(mount.readOnly ? ["ro"] : []), ...(options.selinuxLabel ? ["Z"] : [])];
      const suffix = mountOptions.length === 0 ? "" : `:${mountOptions.join(",")}`;
      return ["-v", `${mount.hostPath}:${mount.containerPath}${suffix}`];
    }),
    ...(options.memoryCap && spec.memoryBytes !== null ? ["--memory", `${spec.memoryBytes}b`] : []),
    ...(options.cpuCap && spec.cpus !== null ? ["--cpus", String(spec.cpus)] : []),
    ...(spec.platform === null ? [] : ["--platform", spec.platform]),
    ...(spec.gpu ? options.gpuFlags : []),
    spec.image,
    ...spec.args,
  ];
}

/** `run --rm` of one command. Like a start, it never pulls: a missing image must not become a 5 GB download. */
export function oneOffArgv(binary: string, spec: OneOffSpec, gpuFlags: readonly string[]): string[] {
  return [
    binary,
    "run",
    "--rm",
    "--name",
    spec.name,
    "--pull=never",
    ...(spec.entrypoint === undefined ? [] : ["--entrypoint", spec.entrypoint]),
    ...(spec.gpu ? gpuFlags : []),
    ...(spec.platform === null ? [] : ["--platform", spec.platform]),
    spec.image,
    ...spec.args,
  ];
}
