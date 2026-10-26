import type { ApiError } from "../../shared/api-error.ts";
import os from "node:os";
import { EXIT_NOT_FOUND, type CommandResult, type CommandRunner } from "../process/command-runner.ts";
import { excerpt } from "../app/diagnosis-log.ts";
import { imageArchive } from "../images/image-archive.ts";
import type { DownloadedImage } from "../images/image-download.ts";
import { parseAppleProgress } from "./apple-progress.ts";
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


const START_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 60_000;
/** A load can print many lines. Only the last ones are kept, because the failure is told at the end. */
const LOAD_OUTPUT_LINES = 200;

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
 * and the image is the arm64 one aidm-ui loaded. A read-only mount
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

/** What `container image load` printed: the references of the images it loaded, one per line on stdout (1.6.1: ImageLoad.swift). */
export type AppleLoadResult = { ok: true; references: string[] } | { ok: false; error: ApiError };

/**
 * Streams an image to `container image load` as an OCI layout archive. The
 * tool reads only that format, names the image from the layout's
 * annotations, and has no other way to take a file from a pipe. Only the
 * exit status counts: the tool can print 100% in the same second as it fails
 * (seen at 36% and at 50% on a real Mac).
 */
export async function loadIntoAppleTool(
  runner: CommandRunner,
  image: DownloadedImage,
  options: { signal?: AbortSignal; log?: (line: string) => void },
): Promise<AppleLoadResult> {
  const log = options.log ?? (() => {});
  const argv = [APPLE_TOOL, "image", "load"];
  const kept: string[] = [];
  const references: string[] = [];
  let said: number | null = null;
  const result = await runner.stream(argv, {
    signal: options.signal,
    stdin: imageArchive(image, "oci"),
    onLine: (line, from) => {
      kept.push(line);
      if (kept.length > LOAD_OUTPUT_LINES) kept.shift();
      said = parseAppleProgress(line)?.percent ?? said;
      if (from === "stdout" && line.trim() !== "" && parseAppleProgress(line) === null) references.push(line.trim());
    },
  });
  if (result.exitCode === 0) return { ok: true, references };
  if (options.signal?.aborted) return { ok: false, error: { code: "download.cancelled", data: {} } };
  if (SERVICE_DOWN.test(kept.join("\n"))) return { ok: false, error: { code: "runtime.apple_not_started", data: {} } };
  const percent = said === null ? "" : `, after the tool said ${said}%`;
  log(`Load check failed for ${image.name}: expected exit 0, found exit ${result.exitCode}${percent}: ${excerpt(kept.slice(-5).join(" / "))}`);
  return { ok: false, error: { code: "runtime.load_failed", data: { exitCode: result.exitCode } } };
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

    // The tool spools the archive from standard input to a temporary file,
    // its service unpacks that file into a temporary folder, and the blobs
    // stay in its content store (1.6.1: ImageLoad.swift, ImagesService.load).
    loadCopies: 3,

    async load(image, loadOptions = {}) {
      const loaded = await loadIntoAppleTool(runner, image, { signal: loadOptions.signal, log });
      return loaded.ok ? ok(undefined) : loaded;
    },

    async verifyImage(image) {
      const result = await run([APPLE_TOOL, "image", "inspect", image.name]);
      if (result.exitCode !== 0) {
        const down = serviceDown(result);
        if (down === null) log(`Image check failed for ${image.name}: expected exit 0 and the manifest ${image.manifest.digest}, found exit ${result.exitCode}: ${excerpt(result.stderr || result.stdout)}`);
        return down ?? fail("runtime.image_not_verified", { name: image.name });
      }
      // The tool wraps a loaded manifest in an index of its own, so the
      // manifest digest is found among the image's variants (1.6.1: ImageResource).
      const parsed = parseJson(result.stdout);
      const entry = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
      const descriptor = asRecord(asRecord(entry?.configuration)?.descriptor);
      const variants = Array.isArray(entry?.variants) ? entry.variants : [];
      const digests = [descriptor?.digest, ...variants.map((variant) => asRecord(variant)?.digest)];
      if (!digests.includes(image.manifest.digest)) {
        log(`Image check failed for ${image.name}: expected the manifest ${image.manifest.digest} among the image's digests, found ${digests.filter((digest) => digest !== undefined).join(", ") || "none"}: ${excerpt(result.stdout)}`);
        return fail("runtime.image_not_verified", { name: image.name });
      }
      // The tool runs an image by its name.
      return ok(image.name);
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
