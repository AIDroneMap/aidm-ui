import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runArgv as dockerRunArgv, dockerPullParser } from "../server/runtimes/docker.ts";
import { runArgv as podmanRunArgv } from "../server/runtimes/podman.ts";
import {
  fail,
  ok,
  type ContainerRuntime,
  type ContainerSpec,
  type ContainerStatus,
  type PullProgress,
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

/** The progress the Docker parser gives for the recorded pull. */
function recordedPullProgress(): PullProgress[] {
  const parse = dockerPullParser();
  const progress: PullProgress[] = [];
  for (const line of recordedText("docker", "pull-no-tty").split("\n")) {
    const step = parse(line);
    if (step !== null) progress.push(step);
  }
  return progress;
}

/**
 * The token in the config file the arguments point to, as the task API reads
 * it. Undefined when the arguments name no config file. Null when they do and
 * the file cannot be read, has no usable JSON or has no token.
 */
function readConfigToken(spec: ContainerSpec): string | null | undefined {
  const at = spec.args.indexOf("--config");
  if (at === -1) return undefined;
  const path = spec.args[at + 1];
  if (path === undefined || !path.endsWith(".json")) return null;
  // The file is seen through the mount whose folder holds it, as in a container.
  const mount = spec.mounts.find((candidate) => path.startsWith(`${candidate.containerPath}/`));
  if (mount === undefined) return null;
  try {
    const text = readFileSync(join(mount.hostPath, path.slice(mount.containerPath.length + 1)), "utf8");
    const token = (JSON.parse(text) as { token?: unknown } | null)?.token;
    return typeof token === "string" ? token : null;
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
  readonly images = new Set<string>();
  readonly pulls: string[] = [];
  readonly starts: Array<{ spec: ContainerSpec; argv: string[] }> = [];
  readonly stops: string[] = [];
  readonly removals: string[] = [];
  readonly removedImages: string[] = [];

  private readonly pullOutput: PullProgress[];
  private failingPulls = 0;
  private readonly containers = new Map<string, FakeContainer>();
  private nextContainer = 1;

  constructor(options: { id?: RuntimeId; detection?: Partial<RuntimeDetection>; pullOutput?: PullProgress[] } = {}) {
    this.id = options.id ?? "podman";
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
    this.pullOutput = options.pullOutput ?? recordedPullProgress();
  }

  async detect(): Promise<RuntimeDetection> {
    return { ...this.detection };
  }

  /** The next `count` pulls send some progress and then fail, as an interrupted pull does. */
  failNextPulls(count: number): void {
    this.failingPulls = count;
  }

  async pull(
    image: string,
    options: { platform?: string | null; onProgress?: (progress: PullProgress) => void; signal?: AbortSignal } = {},
  ): Promise<RuntimeResult<void>> {
    this.pulls.push(image);
    const interrupted = this.failingPulls > 0;
    if (interrupted) this.failingPulls--;
    const sent = interrupted ? Math.ceil(this.pullOutput.length / 2) : this.pullOutput.length;
    for (const progress of this.pullOutput.slice(0, sent)) {
      if (options.signal?.aborted) return fail("runtime.pull_failed", { exitCode: 130 });
      options.onProgress?.(progress);
      await Promise.resolve();
    }
    if (interrupted || options.signal?.aborted) {
      return fail("runtime.pull_failed", { exitCode: interrupted ? 1 : 130 });
    }
    this.images.add(image);
    return ok(undefined);
  }

  async start(spec: ContainerSpec): Promise<RuntimeResult<{ containerId: string }>> {
    if (this.containers.has(spec.name)) return fail("runtime.name_in_use", { name: spec.name });
    if (!this.images.has(spec.image)) return fail("runtime.image_not_found");

    // Bun lets two servers share a port on Linux, a real runtime would not.
    const wanted = spec.publish.hostPort;
    const taken = [...this.containers.values()].some(
      (other) => other.running && wanted !== 0 && Number(new URL(other.api.address).port) === wanted,
    );
    if (taken) return fail("runtime.port_in_use", { port: spec.publish.hostPort });

    // The real task API exits with status 1 when it cannot read its config file.
    // The fake does the same: the container is created and is already stopped.
    const config = readConfigToken(spec);
    const api = new FakeTaskApi({ token: config === undefined ? "fake-token" : (config ?? "") });
    if (config !== null) {
      try {
        await api.start(spec.publish.hostPort);
      } catch {
        return fail("runtime.port_in_use", { port: spec.publish.hostPort });
      }
    }

    const argv = (this.id === "docker" ? dockerRunArgv : podmanRunArgv)(spec, this.detection);
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
