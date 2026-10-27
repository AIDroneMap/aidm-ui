import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult } from "../server/process/command-runner.ts";
import { runArgv as appleRunArgv } from "../server/runtimes/apple-container.ts";
import { oneOffArgv } from "../server/runtimes/cli-runtime.ts";
import type { DownloadedImage } from "../server/images/image-download.ts";
import { GPU_FLAGS as DOCKER_GPU_FLAGS, runArgv as dockerRunArgv } from "../server/runtimes/docker.ts";
import { GPU_FLAGS as PODMAN_GPU_FLAGS, runArgv as podmanRunArgv } from "../server/runtimes/podman.ts";
import {
  fail,
  ok,
  type ContainerRuntime,
  type ContainerSpec,
  type ContainerStatus,
  type OneOffSpec,
  type RuntimeDetection,
  type RuntimeId,
  type RuntimeResult,
} from "../server/runtimes/runtime.ts";
import { FakeTaskApi } from "./fake-task-api.ts";
import { recordedText } from "./scripted-runner.ts";

interface FakeContainer {
  spec: ContainerSpec;
  containerId: string;
  api: FakeTaskApi;
  running: boolean;
  exitCode: number | null;
  lines: string[];
  followers: Set<(line: string) => void>;
  /** Ends every follower of the log. */
  endFollowers: Set<() => void>;
}

const VERSIONS: Record<RuntimeId, string> = { podman: "5.8.9", docker: "29.9.2", "apple-container": "1.6.1" };

/**
 * The token in the config file the arguments point to, as the task API reads
 * it. Undefined when the arguments name no config file. Null when they do and
 * the file cannot be read, has no usable JSON or has no token.
 */
function readConfigToken(spec: ContainerSpec): string | null | undefined {
  const config = readConfig(spec);
  if (config === undefined || config === null) return config;
  return typeof config.token === "string" ? config.token : null;
}

/** The socket path the config file names, the one a task API that can listen on a socket would use. */
function readConfigSocket(spec: ContainerSpec): string | null {
  const socket = readConfig(spec)?.socket;
  return typeof socket === "string" ? socket : null;
}

function readConfig(spec: ContainerSpec): Record<string, unknown> | null | undefined {
  const at = spec.args.indexOf("--config");
  if (at === -1) return undefined;
  const path = spec.args[at + 1];
  if (path === undefined || !path.endsWith(".json")) return null;
  // The file is seen through the mount whose folder holds it, as in a container.
  const mount = spec.mounts.find((candidate) => path.startsWith(`${candidate.containerPath}/`));
  if (mount === undefined) return null;
  try {
    const text = readFileSync(join(mount.hostPath, path.slice(mount.containerPath.length + 1)), "utf8");
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A container runtime in memory, for tests of the engine manager. A started
 * container runs a fake task API on its published port, so the manager's task
 * client has a real engine to talk to.
 */
export class FakeRuntime implements ContainerRuntime {
  readonly id: RuntimeId;
  detection: RuntimeDetection;
  /** The images it holds, by the pinned reference "<image>@<digest>". */
  readonly images = new Set<string>();
  /** Every image it was given to load, by its pinned reference. */
  readonly loads: string[] = [];
  readonly loadCopies = 1;
  readonly starts: Array<{ spec: ContainerSpec; argv: string[] }> = [];
  /** Every one-off run, with the command line the real adapter would use. */
  readonly oneOffs: Array<{ spec: OneOffSpec; argv: string[]; signal: AbortSignal | undefined }> = [];
  readonly stops: string[] = [];
  readonly removals: string[] = [];
  readonly removedImages: string[] = [];
  /** The task API version the engine of an image reports; default: whatever the fake task API says. */
  versionOf: ((image: string) => string) | undefined;
  /** True for an image whose engine starts but never answers. */
  silent: (image: string) => boolean;

  private failingLoads = 0;
  /** The names of the images it loaded. */
  private readonly loadedNames = new Set<string>();
  private imageRemovalRefused = false;
  /** While set, a one-off run waits for this to resolve or for its signal to fire. */
  private oneOffHold: Promise<void> | undefined;
  private oneOffAnswer: RuntimeResult<CommandResult> = ok({
    exitCode: 0,
    stdout: recordedText("nvidia", "smi-l"),
    stderr: "",
  });
  private readonly containers = new Map<string, FakeContainer>();
  private nextContainer = 1;

  constructor(
    options: {
      id?: RuntimeId;
      detection?: Partial<RuntimeDetection>;
      versionOf?: (image: string) => string;
      silent?: (image: string) => boolean;
    } = {},
  ) {
    this.id = options.id ?? "podman";
    this.versionOf = options.versionOf;
    this.silent = options.silent ?? (() => false);
    this.detection = {
      id: this.id,
      available: true,
      version: VERSIONS[this.id],
      memoryCapEnforced: true,
      cpuCapEnforced: true,
      storagePath: null,
      problem: null,
      ...options.detection,
    };
  }

  async detect(): Promise<RuntimeDetection> {
    return { ...this.detection };
  }

  /** The next `count` loads fail, as a tool that cannot read the archive does. */
  failNextLoads(count: number): void {
    this.failingLoads = count;
  }

  /** Puts an image in place as if it had been pulled or loaded before. */
  holdImage(pinned: string): void {
    this.images.add(pinned);
  }

  async load(image: DownloadedImage, options: { signal?: AbortSignal } = {}): Promise<RuntimeResult<void>> {
    const pinned = `${image.pinned.repository}@${image.pinned.digest}`;
    this.loads.push(pinned);
    if (options.signal?.aborted) return fail("download.cancelled");
    if (this.failingLoads > 0) {
      this.failingLoads--;
      return fail("runtime.load_failed", { exitCode: 1 });
    }
    this.loadedNames.add(image.name);
    this.images.add(pinned);
    return ok(undefined);
  }

  /** Like Podman and Docker's containerd store, it finds a loaded image again by its pinned reference. */
  async verifyImage(image: DownloadedImage): Promise<RuntimeResult<string>> {
    const pinned = `${image.pinned.repository}@${image.pinned.digest}`;
    if (!this.loadedNames.has(image.name) || !this.images.has(pinned)) return fail("runtime.image_not_verified", { name: image.name });
    return ok(pinned);
  }

  /** What the next one-off runs answer, until it is set again. Default: the recorded `nvidia-smi -L`, exit 0. */
  answerOneOffs(answer: RuntimeResult<CommandResult>): void {
    this.oneOffAnswer = answer;
  }

  /** Makes the next one-off runs wait, as a hung command does. The returned function lets them finish. */
  holdOneOffs(): () => void {
    let release = () => {};
    this.oneOffHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  /** From now on removing an image fails and the image stays. */
  refuseImageRemoval(): void {
    this.imageRemovalRefused = true;
  }

  async runOnce(spec: OneOffSpec, _timeoutMs?: number, signal?: AbortSignal): Promise<RuntimeResult<CommandResult>> {
    const flags = this.id === "docker" ? DOCKER_GPU_FLAGS : PODMAN_GPU_FLAGS;
    this.oneOffs.push({ spec, argv: oneOffArgv(this.id, spec, flags), signal });
    if (this.oneOffHold !== undefined) {
      const aborted = new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      await Promise.race([this.oneOffHold, aborted]);
    }
    // Like the real adapter, a run that did not end well leaves nothing behind.
    const answer = signal?.aborted
      ? ok<CommandResult>({ exitCode: 137, stdout: "", stderr: "" })
      : !this.images.has(spec.image)
        ? // Like the real tools, it never pulls.
          ok<CommandResult>({ exitCode: 125, stdout: "", stderr: "Error: image not known" })
        : this.oneOffAnswer;
    if (!answer.ok || answer.value.exitCode !== 0) this.removals.push(spec.name);
    return answer;
  }

  async start(spec: ContainerSpec): Promise<RuntimeResult<{ containerId: string }>> {
    if (this.containers.has(spec.name)) return fail("runtime.name_in_use", { name: spec.name });
    if (!this.images.has(spec.image)) return fail("runtime.image_not_found");

    // Bun lets two servers share a port on Linux, a real runtime would not.
    const wanted = spec.publish?.hostPort ?? 0;
    const taken = [...this.containers.values()].some(
      (other) => other.running && wanted !== 0 && Number(new URL(other.api.address).port) === wanted,
    );
    if (taken) return fail("runtime.port_in_use", { port: wanted });

    // The real task API exits with status 1 when it cannot read its config file.
    // The fake does the same: the container is created and is already stopped.
    const config = readConfigToken(spec);
    const version = this.versionOf?.(spec.image);
    const api = new FakeTaskApi({
      token: config === undefined ? "fake-token" : (config ?? ""),
      info: version === undefined ? undefined : { version },
    });
    // A silent engine runs but listens on nothing, so every call to it is refused.
    if (config !== null && !this.silent(spec.image)) {
      try {
        // Like the tool's relay, the socket on this computer reaches the API only when the API listens on the path inside.
        if (spec.publishSocket !== undefined) {
          if (readConfigSocket(spec) === spec.publishSocket.containerPath) await api.startOnSocket(spec.publishSocket.hostPath);
        } else {
          await api.start(spec.publish?.hostPort ?? 0);
        }
      } catch {
        return fail("runtime.port_in_use", { port: wanted });
      }
    }

    const argv =
      this.id === "apple-container"
        ? appleRunArgv(spec)
        : (this.id === "docker" ? dockerRunArgv : podmanRunArgv)(spec, this.detection);
    this.starts.push({ spec, argv });
    const containerId = String(this.nextContainer++).padStart(64, "0");
    this.containers.set(spec.name, {
      spec,
      containerId,
      api,
      running: config !== null,
      exitCode: config === null ? 1 : null,
      lines: [],
      followers: new Set(),
      endFollowers: new Set(),
    });
    return ok({ containerId });
  }

  async stop(name: string): Promise<RuntimeResult<void>> {
    this.stops.push(name);
    const container = this.containers.get(name);
    if (container !== undefined) await this.halt(container, 0);
    return ok(undefined);
  }

  async remove(name: string): Promise<RuntimeResult<void>> {
    this.removals.push(name);
    const container = this.containers.get(name);
    if (container !== undefined) {
      await this.halt(container, 0);
      this.containers.delete(name);
    }
    return ok(undefined);
  }

  async removeImage(image: string): Promise<RuntimeResult<void>> {
    this.removedImages.push(image);
    if (this.imageRemovalRefused) return fail("runtime.command_failed", { operation: "removeImage", exitCode: 1 });
    this.images.delete(image);
    return ok(undefined);
  }

  async status(name: string): Promise<RuntimeResult<ContainerStatus>> {
    const container = this.containers.get(name);
    if (container === undefined) return ok({ state: "missing", exitCode: null, oomKilled: null });
    if (container.running) return ok({ state: "running", exitCode: null, oomKilled: false });
    return ok({ state: "stopped", exitCode: container.exitCode, oomKilled: false });
  }

  async logs(
    name: string,
    options: { follow: boolean; tail?: number; onLine: (line: string) => void; signal?: AbortSignal },
  ): Promise<RuntimeResult<void>> {
    const container = this.containers.get(name);
    if (container === undefined) return ok(undefined);
    const history = options.tail === undefined ? container.lines : options.tail === 0 ? [] : container.lines.slice(-options.tail);
    for (const line of history) options.onLine(line);
    if (!options.follow || !container.running || options.signal?.aborted) return ok(undefined);

    await new Promise<void>((resolve) => {
      const finish = () => {
        container.followers.delete(options.onLine);
        container.endFollowers.delete(finish);
        options.signal?.removeEventListener("abort", finish);
        resolve();
      };
      container.followers.add(options.onLine);
      container.endFollowers.add(finish);
      options.signal?.addEventListener("abort", finish, { once: true });
    });
    return ok(undefined);
  }

  /** The fake task API inside the container, to drive the engine in a test. */
  engine(name: string): FakeTaskApi | undefined {
    return this.containers.get(name)?.api;
  }

  /** The container dies: its task API stops and it is stopped with exit code 137. */
  async kill(name: string): Promise<void> {
    const container = this.containers.get(name);
    if (container !== undefined) await this.halt(container, 137);
  }

  /** A line in the container's log, delivered to every follower. */
  emitLog(name: string, line: string): void {
    const container = this.containers.get(name);
    if (container === undefined) throw new Error(`The fake runtime has no container ${name}.`);
    container.lines.push(line);
    for (const follower of [...container.followers]) follower(line);
  }

  private async halt(container: FakeContainer, exitCode: number): Promise<void> {
    if (container.running) {
      container.running = false;
      container.exitCode = exitCode;
      await container.api.stop();
    }
    for (const end of [...container.endFollowers]) end();
  }
}
