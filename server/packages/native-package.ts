import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { InstallProgressView } from "../../shared/api-types.ts";
import { downloadVerified } from "../downloads/downloader.ts";
import type { FreeBytes } from "../machine/disk.ts";
import { DOWNLOAD_FREE_DISK_MARGIN } from "../machine/thresholds.ts";
import type { ManifestVariant } from "../manifest/schema.ts";
import type { CommandRunner } from "../process/command-runner.ts";
import type { NativeProcess, Settings } from "../settings/settings.ts";
import { TaskClient } from "../task-api/task-client.ts";
import { fail, ok, type EnginePackage, type PackageResult, type PackageStartOptions, type PackageStatus } from "./engine-package.ts";

export type NativeVariant = Extract<ManifestVariant, { kind: "native" }>;

/** The task API's program inside a package folder. */
export const EXECUTABLE_NAME = "aidm-api";
/**
 * Where the engine sits inside a package folder, passed to the task API as
 * --odx_path. No native engine build exists yet (AIDroneMap/aidm#15), so this
 * is a convention until those builds define the real layout.
 */
export const ENGINE_PATH_IN_PACKAGE = "engine";
/** A program that ignores the polite stop is ended after this long. */
export const STOP_GRACE_MS = 10_000;
const LOG_POLL_MS = 200;
const IDENTIFY_TIMEOUT_MS = 2000;
const UNPACK_TIMEOUT_MS = 10 * 60_000;
/** Bytes read from the output file in one go. */
const READ_CHUNK_BYTES = 256 * 1024;
/** A line longer than this many characters is handed over in pieces. */
const MAX_LINE_CHARS = 64 * 1024;

/** What the manager knows about a program it started itself during this run of aidm-ui. */
export interface ChildState {
  /** Null while it runs. */
  exitCode: number | null;
}

export interface SpawnedEngine {
  pid: number;
  /** Resolves with the exit code when the program ends. */
  exited: Promise<number>;
}

export type SpawnEngine = (argv: string[], options: { cwd: string; outputFile: string }) => SpawnedEngine;

/**
 * Starts the program detached, in a session of its own, so that it goes on
 * when aidm-ui stops. Its output goes to a file and not to a pipe: a pipe
 * would break when aidm-ui exits, and the engine would die on its next write.
 */
export const spawnEngine: SpawnEngine = (argv, options) => {
  const output = openSync(options.outputFile, "w", 0o600);
  try {
    const child = Bun.spawn(argv, {
      cwd: options.cwd,
      stdin: "ignore",
      stdout: output,
      stderr: output,
      detached: true,
    });
    child.unref();
    return { pid: child.pid, exited: child.exited };
  } finally {
    closeSync(output);
  }
};

export interface NativePackageDeps {
  variant: NativeVariant;
  /** The package version, which names the folder. */
  version: string;
  dataFolder: string;
  freeBytes: FreeBytes;
  settings: Pick<Settings, "get" | "set">;
  runner: CommandRunner;
  /** The token the running engine was started with, to confirm that a program found by its pid is ours. */
  token: () => string | null;
  /** True when systemd-run can give the program a memory limit. */
  systemd: () => boolean;
  /** The programs this run of aidm-ui started. Shared by every package object of the manager. */
  children: Map<number, ChildState>;
  log: (line: string) => void;
  spawn?: SpawnEngine;
  fetch?: typeof fetch;
  /** Waits between download attempts. */
  backoffMs?: (attempt: number) => number;
  stopGraceMs?: number;
  logPollMs?: number;
  /** Added to the engine's command line, such as the test flag of the integration test. */
  extraArgs?: string[];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Not ours to signal, but there.
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && (process.platform === "win32" || (stats.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/** Who answers on the recorded port. */
type Identity = "ours" | "foreign" | "silent";

/** An engine package that is a folder run as a program on this computer. */
export class NativePackage implements EnginePackage {
  readonly kind = "native";
  readonly directory: string;
  readonly executable: string;
  readonly enginePath: string;
  private readonly packagesFolder: string;
  private readonly outputFile: string;

  constructor(private readonly deps: NativePackageDeps) {
    this.packagesFolder = join(deps.dataFolder, "engine-packages");
    this.directory = join(this.packagesFolder, deps.version);
    this.executable = join(this.directory, EXECUTABLE_NAME);
    this.enginePath = join(this.directory, ENGINE_PATH_IN_PACKAGE);
    this.outputFile = join(deps.dataFolder, "logs", "native-engine.out");
  }

  /** True when this version is unpacked and complete. A folder is only ever put in place whole. */
  isInstalled(): boolean {
    return isExecutableFile(this.executable);
  }

  async preflight(): Promise<PackageResult<void>> {
    const needed = Math.ceil(this.deps.variant.size * (1 + DOWNLOAD_FREE_DISK_MARGIN));
    const free = this.deps.freeBytes(this.deps.dataFolder);
    if (free < needed) return fail("install.not_enough_space", { needed, free });
    return ok(undefined);
  }

  async install(options: {
    onProgress?: (progress: InstallProgressView) => void;
    signal?: AbortSignal;
  }): Promise<PackageResult<void>> {
    const { variant } = this.deps;
    const space = await this.preflight();
    if (!space.ok) return space;
    // A version that is kept as the previous one is already here.
    if (this.isInstalled()) return ok(undefined);

    options.onProgress?.({ phase: "pulling", size: variant.size, layersDone: null, layersTotal: null, attempt: 1, maxAttempts: 1 });
    const archive = join(this.deps.dataFolder, "downloads", `aidm-api-${this.deps.version}.tar.gz`);
    const downloaded = await downloadVerified(
      { url: variant.url, size: variant.size, sha256: variant.sha256, path: archive },
      {
        fetch: this.deps.fetch,
        signal: options.signal,
        freeBytes: this.deps.freeBytes,
        backoffMs: this.deps.backoffMs,
      },
    );
    if (!downloaded.ok) return { ok: false, error: downloaded.error };
    if (options.signal?.aborted) return fail("download.cancelled");

    const unpacked = await this.unpack(archive);
    rmSync(archive, { force: true });
    return unpacked;
  }

  /**
   * Unpacks into a temporary sibling and renames when it is whole, so a
   * half-unpacked folder is never used. The archive holds one folder, which
   * becomes the package folder; an archive of loose files is used as it is.
   */
  private async unpack(archive: string): Promise<PackageResult<void>> {
    const temporary = join(this.packagesFolder, `.${this.deps.version}.unpacking`);
    try {
      rmSync(temporary, { recursive: true, force: true });
      mkdirSync(temporary, { recursive: true });
      const result = await this.deps.runner.run(["tar", "-xzf", archive, "-C", temporary], { timeoutMs: UNPACK_TIMEOUT_MS });
      if (result.exitCode !== 0) {
        this.deps.log(`Unpacking the engine failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`);
        return fail("install.unpack_failed", { reason: "tar", exitCode: result.exitCode });
      }
      const entries = readdirSync(temporary);
      const only = entries.length === 1 ? join(temporary, entries[0] as string) : null;
      const root = only !== null && lstatSync(only).isDirectory() ? only : temporary;
      if (!isExecutableFile(join(root, EXECUTABLE_NAME))) return fail("install.unpack_failed", { reason: "executable_missing" });
      rmSync(this.directory, { recursive: true, force: true });
      renameSync(root, this.directory);
      return ok(undefined);
    } catch (error) {
      this.deps.log(`Unpacking the engine failed: ${error instanceof Error ? error.message : String(error)}`);
      return fail("install.unpack_failed", { reason: "files" });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  async start(options: PackageStartOptions): Promise<PackageResult<{ address: string }>> {
    // A program from an earlier start must go, or two engines would share the data folder.
    await this.stop();

    if (!this.isInstalled()) return fail("runtime.start_failed", { reason: "not_unpacked" });
    const { deps } = this;
    try {
      mkdirSync(join(deps.dataFolder, "logs"), { recursive: true, mode: 0o700 });
    } catch {
      return fail("runtime.start_failed", { reason: "files" });
    }

    const program = [
      this.executable,
      "--port",
      String(options.hostPort),
      "--token",
      options.token,
      "--parallel_queue_processing",
      "1",
      "--odx_path",
      this.enginePath,
      ...(deps.extraArgs ?? []),
    ];
    // The task API has no memory flag. The limit has to come from the system, and only systemd gives one to a program that is not a container.
    const argv =
      options.memoryBytes !== null && deps.systemd()
        ? ["systemd-run", "--user", "--scope", "--quiet", "-p", `MemoryMax=${options.memoryBytes}`, "--", ...program]
        : program;

    let child: SpawnedEngine;
    try {
      // The API keeps its data and temporary folders relative to where it runs.
      child = (deps.spawn ?? spawnEngine)(argv, { cwd: options.engineDataFolder, outputFile: this.outputFile });
    } catch (error) {
      return fail("runtime.start_failed", { reason: errorCode(error) ?? "spawn" });
    }
    const state: ChildState = { exitCode: null };
    deps.children.set(child.pid, state);
    void child.exited.then(
      (code) => {
        state.exitCode = code;
      },
      () => {
        state.exitCode = -1;
      },
    );
    deps.settings.set("local.native", { pid: child.pid, port: options.hostPort, version: deps.version });
    return ok({ address: `http://127.0.0.1:${options.hostPort}` });
  }

  /** Whether the recorded program is alive, as far as this run of aidm-ui can tell. */
  private alive(record: NativeProcess): boolean {
    const child = this.deps.children.get(record.pid);
    if (child !== undefined && child.exitCode !== null) return false;
    return isAlive(record.pid);
  }

  /**
   * A pid can be reused by another program, so the pid alone proves nothing.
   * The info route answering with the stored token proves the program is our
   * engine. One that does not answer is still ours when its command line
   * carries the token. Otherwise it is taken for ours only when this run of
   * aidm-ui started it.
   */
  private async identify(record: NativeProcess): Promise<Identity> {
    const token = this.deps.token();
    if (token === null) return "silent";
    const client = new TaskClient(
      { address: `http://127.0.0.1:${record.port}`, token },
      { timeoutMs: IDENTIFY_TIMEOUT_MS },
    );
    const info = await client.info();
    if (info.ok) return "ours";
    if (info.failure.kind !== "unreachable") return "foreign";
    return (await this.commandLineHasToken(record.pid, token)) ? "ours" : "silent";
  }

  /** True when the program with this pid was started with `--token <token>`. False also when its command line cannot be read. */
  private async commandLineHasToken(pid: number, token: string): Promise<boolean> {
    try {
      if (process.platform === "linux") {
        const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        return parts.some((part, index) => part === "--token" && parts[index + 1] === token);
      }
      const shown = await this.deps.runner.run(["ps", "-p", String(pid), "-o", "command="]);
      return shown.exitCode === 0 && shown.stdout.includes(`--token ${token}`);
    } catch {
      return false;
    }
  }

  async status(): Promise<PackageResult<PackageStatus>> {
    const record = this.deps.settings.get("local.native");
    if (record === null) return ok({ state: "missing", exitCode: null });
    const exitCode = this.deps.children.get(record.pid)?.exitCode ?? null;
    if (!this.alive(record)) return ok({ state: "stopped", exitCode });
    const identity = await this.identify(record);
    const running = identity === "ours" || (identity === "silent" && this.deps.children.has(record.pid));
    return ok(running ? { state: "running", exitCode: null } : { state: "stopped", exitCode: null });
  }

  async stop(): Promise<PackageResult<void>> {
    const { deps } = this;
    const record = deps.settings.get("local.native");
    if (record === null) return ok(undefined);
    try {
      if (this.alive(record)) {
        const identity = await this.identify(record);
        if (identity === "foreign" || (identity === "silent" && !deps.children.has(record.pid))) {
          // Not our engine, or no way to tell: the pid may belong to another program now, so it is left alone.
          deps.log("A program with the recorded process number is not the engine, so it was not stopped.");
        } else {
          await this.end(record);
        }
      }
    } finally {
      deps.children.delete(record.pid);
      deps.settings.set("local.native", null);
    }
    return ok(undefined);
  }

  /** SIGTERM to the program's whole process group, then SIGKILL if it is still there after the grace. */
  private async end(record: NativeProcess): Promise<void> {
    this.signal(record.pid, "SIGTERM");
    if (await this.waitForExit(record, this.deps.stopGraceMs ?? STOP_GRACE_MS)) return;
    this.deps.log("The engine did not stop when asked. It is ended by force.");
    this.signal(record.pid, "SIGKILL");
    await this.waitForExit(record, 2000);
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      // The program leads a session of its own, so the group is the program and what it started.
      if (process.platform === "win32") process.kill(pid, signal);
      else process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  }

  private async waitForExit(record: NativeProcess, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (this.alive(record)) {
      if (Date.now() >= deadline) return false;
      await Bun.sleep(25);
    }
    return true;
  }

  async logs(options: {
    follow: boolean;
    tail?: number;
    onLine: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<PackageResult<void>> {
    const reader = new OutputReader(this.outputFile, options.onLine);
    if (options.tail === undefined) reader.pump();
    else if (options.tail === 0) reader.skipToEnd();
    else reader.lastLines(options.tail);

    if (options.follow) {
      for (;;) {
        const record = this.deps.settings.get("local.native");
        const running = record !== null && this.alive(record);
        // One more look after the program ended, for what it wrote last.
        reader.pump();
        if (!running || options.signal?.aborted) break;
        await waitOrAbort(this.deps.logPollMs ?? LOG_POLL_MS, options.signal);
      }
    }
    reader.finish();
    return ok(undefined);
  }

  /** The program is stopped and forgotten, and its folder stays. */
  async removeContainer(): Promise<PackageResult<void>> {
    return this.stop();
  }

  async remove(): Promise<PackageResult<void>> {
    rmSync(this.directory, { recursive: true, force: true });
    return ok(undefined);
  }
}

function waitOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Reads the engine's output file from an offset, line by line, holding back a line that is not finished. */
class OutputReader {
  private offset = 0;
  private pending = "";
  private decoder = new StringDecoder("utf8");

  constructor(
    private readonly path: string,
    private readonly onLine: (line: string) => void,
  ) {}

  private size(): number {
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  skipToEnd(): void {
    this.offset = this.size();
  }

  /** Hands over the last `count` lines of the file and follows from its end. */
  lastLines(count: number): void {
    const end = this.size();
    const start = Math.max(0, end - READ_CHUNK_BYTES);
    const text = this.read(start, end);
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    // The first line may be cut by the read.
    if (start > 0) lines.shift();
    for (const line of lines.slice(-count)) this.emit(line);
    this.offset = end;
  }

  /** Reads what was added since the last call. */
  pump(): void {
    let end = this.size();
    // A new start empties the file.
    if (end < this.offset) {
      this.offset = 0;
      this.pending = "";
      this.decoder = new StringDecoder("utf8");
    }
    while (this.offset < end) {
      const to = Math.min(end, this.offset + READ_CHUNK_BYTES);
      const text = this.decoder.write(this.readBytes(this.offset, to));
      this.offset = to;
      this.push(text);
      end = Math.max(end, this.size());
    }
  }

  /** Hands over a last line that had no line break. */
  finish(): void {
    this.push(this.decoder.end());
    if (this.pending !== "") this.emit(this.pending);
    this.pending = "";
  }

  private push(text: string): void {
    this.pending += text;
    for (;;) {
      const newline = this.pending.indexOf("\n");
      if (newline !== -1) {
        this.emit(this.pending.slice(0, newline));
        this.pending = this.pending.slice(newline + 1);
      } else if (this.pending.length > MAX_LINE_CHARS) {
        this.emit(this.pending.slice(0, MAX_LINE_CHARS));
        this.pending = this.pending.slice(MAX_LINE_CHARS);
      } else {
        return;
      }
    }
  }

  private emit(line: string): void {
    this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  private read(from: number, to: number): string {
    return this.readBytes(from, to).toString("utf8");
  }

  private readBytes(from: number, to: number): Buffer {
    if (!existsSync(this.path) || to <= from) return Buffer.alloc(0);
    const fd = openSync(this.path, "r");
    try {
      const buffer = Buffer.alloc(to - from);
      const read = readSync(fd, buffer, 0, buffer.length, from);
      return buffer.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  }
}
