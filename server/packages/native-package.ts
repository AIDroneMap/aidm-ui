import type { ApiError } from "../../shared/api-error.ts";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { parse, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import type { InstallProgressView, VariantId } from "../../shared/api-types.ts";
import { downloadVerified } from "../downloads/downloader.ts";
import type { FreeBytes } from "../machine/disk.ts";
import { DOWNLOAD_FREE_DISK_MARGIN } from "../machine/thresholds.ts";
import type { ManifestVariant } from "../manifest/schema.ts";
import { lineSplitter, type CommandRunner } from "../process/command-runner.ts";
import type { NativeProcess, Settings } from "../settings/settings.ts";
import { fail, ok, type EnginePackage, type PackageResult, type PackageStartOptions, type PackageStatus } from "./engine-package.ts";

export type NativeVariant = Extract<ManifestVariant, { kind: "native" }>;

/** The task API's program inside a package folder. */
export const EXECUTABLE_NAME = "aidm-api";
/**
 * Where the engine sits inside a package folder, written to the task API's
 * config file as odx_path. No native engine build exists yet
 * (AIDroneMap/aidm#15), so this is a convention until those builds define the
 * real layout.
 */
export const ENGINE_PATH_IN_PACKAGE = "engine";
/** A program that ignores the polite stop is ended after this long. */
export const STOP_GRACE_MS = 10_000;
/** A program started inside a systemd scope that ends within this long did not start. */
export const WRAPPED_START_WATCH_MS = 1000;
/** The engine's output file is emptied, after a copy, when it passes this size. */
export const OUTPUT_ROTATE_BYTES = 5 * 1024 * 1024;
/** Copies of the output file kept next to it. */
export const OUTPUT_KEPT_FILES = 3;
/** A log read with no tail starts this many lines back. */
export const LOG_DEFAULT_TAIL_LINES = 500;
/** An archive may unpack to this many times its own size... */
export const UNPACK_SIZE_FACTOR = 4;
/** ...but never to less than this, since a tar file is padded to whole blocks and a tiny archive would otherwise unpack to many times its size. */
export const UNPACK_SIZE_FLOOR = 1024 * 1024;
const LOG_POLL_MS = 200;
const UNPACK_TIMEOUT_MS = 10 * 60_000;
/** Bytes read from the output file in one go. */
const READ_CHUNK_BYTES = 256 * 1024;
/** What the log says of the output a failed systemd scope left behind. */
const SCOPE_FAILURE_LOG_BYTES = 500;

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
 * The file is opened for appending, so that aidm-ui can empty it while the
 * engine writes on, without leaving a hole behind the engine's position.
 */
export const spawnEngine: SpawnEngine = (argv, options) => {
  const output = openSync(options.outputFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_APPEND, 0o600);
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

/** What a caller may change about how packages of this kind run; tests use these. */
export interface NativeOptions {
  spawn?: SpawnEngine;
  fetch?: typeof fetch;
  /** Waits between download attempts. */
  backoffMs?: (attempt: number) => number;
  stopGraceMs?: number;
  logPollMs?: number;
  /** Added to the engine's command line, such as the test flag of the integration test. */
  extraArgs?: string[];
  /** Sends a signal to a process or, with a negative number, to a group. Default: the system's. */
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  /** How long a start inside a systemd scope is watched for an end at once. */
  wrapWatchMs?: number;
  /** The size at which the engine's output file is copied and emptied. */
  outputRotateBytes?: number;
}

export interface NativePackageDeps extends NativeOptions {
  variant: NativeVariant;
  /** The manifest's name for the package, which the progress of its download carries. */
  variantId: VariantId;
  /** The package version, which names the folder. */
  version: string;
  dataFolder: string;
  freeBytes: FreeBytes;
  settings: Pick<Settings, "get" | "set">;
  runner: CommandRunner;
  /** True when systemd-run can give the program a memory limit. */
  systemd: () => boolean;
  /** The programs this run of aidm-ui started. Shared by every package object of the manager. */
  children: Map<number, ChildState>;
  log: (line: string) => void;
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

/**
 * The file the task API reads its options from (--config). It holds the
 * token, so the token never appears on a command line, where any user of the
 * computer could read it. One per version, and the path is also how a running
 * program is recognised as ours.
 */
export function engineConfigFile(dataFolder: string, version: string): string {
  return join(resolvePath(dataFolder), "engine-config", `native-${version}.json`);
}

/** True when the command line starts the task API with this config file. */
function usesConfig(commandLine: string, configFile: string): boolean {
  return ` ${commandLine.trim()} `.includes(` --config ${configFile} `);
}

function inside(folder: string, path: string): boolean {
  const from = relative(folder, path);
  return from === "" || (from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from));
}

/** True when an archive entry could land outside the folder it is unpacked into. */
function unsafeName(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) return true;
  return name.split(/[\\/]/).includes("..");
}

/** True when the archive unpacks to more than `limit` bytes. Stops reading as soon as it does. A file that is not gzip is left to tar to refuse. */
function unpacksBeyond(archive: string, limit: number): Promise<boolean> {
  return new Promise((done) => {
    let total = 0;
    const input = createReadStream(archive);
    const gunzip = createGunzip();
    const finish = (beyond: boolean) => {
      input.destroy();
      gunzip.destroy();
      done(beyond);
    };
    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) finish(true);
    });
    gunzip.on("end", () => finish(false));
    gunzip.on("error", () => finish(false));
    input.on("error", () => finish(false));
    input.pipe(gunzip);
  });
}

/** What is wrong with the unpacked folder, if anything: a link that leaves it, or something that is not a file, a folder or a link. */
function findUnsafeEntry(root: string): "unsafe_link" | "unsafe_entry" | null {
  const realRoot = realpathSync(root);
  const look = (folder: string): "unsafe_link" | "unsafe_entry" | null => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target) || !inside(root, resolvePath(folder, target))) return "unsafe_link";
        try {
          if (!inside(realRoot, realpathSync(path))) return "unsafe_link";
        } catch {
          // A link to something that is not there stays inside, as far as its text says.
        }
      } else if (stats.isDirectory()) {
        const found = look(path);
        if (found !== null) return found;
      } else if (!stats.isFile()) {
        return "unsafe_entry";
      }
    }
    return null;
  };
  return look(root);
}

/** An engine package that is a folder run as a program on this computer. */
export class NativePackage implements EnginePackage {
  readonly kind = "native";
  readonly directory: string;
  readonly executable: string;
  readonly enginePath: string;
  private readonly packagesFolder: string;
  private readonly outputFile: string;
  private readonly configFile: string;

  constructor(private readonly deps: NativePackageDeps) {
    this.packagesFolder = join(deps.dataFolder, "engine-packages");
    this.directory = join(this.packagesFolder, deps.version);
    this.executable = join(this.directory, EXECUTABLE_NAME);
    this.enginePath = join(this.directory, ENGINE_PATH_IN_PACKAGE);
    this.outputFile = join(deps.dataFolder, "logs", "native-engine.out");
    this.configFile = engineConfigFile(deps.dataFolder, deps.version);
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

    let received: number | null = null;
    let retries = 0;
    let lastRetry: ApiError | null = null;
    const report = () =>
      options.onProgress?.({
        phase: "pulling",
        variant: this.deps.variantId,
        steps: [{ id: "engine", size: variant.size }],
        step: "engine",
        stepReceived: received,
        size: variant.size,
        layersDone: null,
        layersTotal: null,
        speed: null,
        retries,
        lastRetry,
      });
    report();
    const archive = join(this.deps.dataFolder, "downloads", `aidm-api-${this.deps.version}.tar.gz`);
    const downloaded = await downloadVerified(
      { url: variant.url, size: variant.size, sha256: variant.sha256, path: archive },
      {
        fetch: this.deps.fetch,
        log: this.deps.log,
        label: `engine program ${this.deps.version}`,
        signal: options.signal,
        freeBytes: this.deps.freeBytes,
        backoffMs: this.deps.backoffMs,
        onProgress: (bytes) => {
          // About two hundred events for the whole download.
          if (received !== null && bytes < variant.size && bytes - received < variant.size / 200) return;
          received = bytes;
          report();
        },
        onRetry: (reason) => {
          retries++;
          lastRetry = reason;
          report();
        },
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
   *
   * The archive is checked before and after tar runs. Before: it must not
   * unpack to more than four times its own size, and no entry may be an
   * absolute path or climb out with "..". After: no link may point outside the
   * folder, nothing may be a device or a pipe, and the program must be a plain
   * file. Tar itself is told not to take owners or permissions from the archive.
   */
  private async unpack(archive: string): Promise<PackageResult<void>> {
    const temporary = join(this.packagesFolder, `.${this.deps.version}.unpacking`);
    const refuse = (reason: string, extra: Record<string, unknown> = {}) => fail<void>("install.unpack_failed", { reason, ...extra });
    try {
      rmSync(temporary, { recursive: true, force: true });
      mkdirSync(temporary, { recursive: true });

      if (await unpacksBeyond(archive, Math.max(UNPACK_SIZE_FLOOR, UNPACK_SIZE_FACTOR * statSync(archive).size))) return refuse("too_large");

      let unsafeEntry = false;
      const listed = await this.deps.runner.stream(["tar", "-tzf", archive], {
        timeoutMs: UNPACK_TIMEOUT_MS,
        onLine: (line, from) => {
          if (from === "stdout" && unsafeName(line)) unsafeEntry = true;
        },
      });
      if (listed.exitCode !== 0) {
        this.deps.log(`Reading the engine archive failed (exit ${listed.exitCode}).`);
        return refuse("tar", { exitCode: listed.exitCode });
      }
      if (unsafeEntry) return refuse("unsafe_path");

      const result = await this.deps.runner.run(
        ["tar", "-xzf", archive, "-C", temporary, "--no-same-owner", "--no-same-permissions"],
        { timeoutMs: UNPACK_TIMEOUT_MS },
      );
      if (result.exitCode !== 0) {
        this.deps.log(`Unpacking the engine failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`);
        return refuse("tar", { exitCode: result.exitCode });
      }
      const unsafe = findUnsafeEntry(temporary);
      if (unsafe !== null) return refuse(unsafe);

      const entries = readdirSync(temporary);
      const only = entries.length === 1 ? join(temporary, entries[0] as string) : null;
      const root = only !== null && lstatSync(only).isDirectory() ? only : temporary;
      const program = join(root, EXECUTABLE_NAME);
      let programStats: ReturnType<typeof lstatSync>;
      try {
        programStats = lstatSync(program);
      } catch {
        return refuse("executable_missing");
      }
      // A link in its place could point at anything inside the folder, including a file that is not the program.
      if (!programStats.isFile()) return refuse("executable_not_a_file");
      chmodSync(program, 0o755);

      rmSync(this.directory, { recursive: true, force: true });
      renameSync(root, this.directory);
      return ok(undefined);
    } catch (error) {
      this.deps.log(`Unpacking the engine failed: ${error instanceof Error ? error.message : String(error)}`);
      return refuse("files");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  async start(options: PackageStartOptions): Promise<PackageResult<{ address: string; memoryCapEnforced?: boolean }>> {
    // A program from an earlier start must go, or two engines would share the data folder. One that cannot be ended blocks the start.
    const stopped = await this.stop();
    if (!stopped.ok) return fail("runtime.start_failed", { reason: "previous_engine_running" });

    if (!this.isInstalled()) return fail("runtime.start_failed", { reason: "not_unpacked" });
    const { deps } = this;
    try {
      mkdirSync(join(deps.dataFolder, "logs"), { recursive: true, mode: 0o700 });
      // The task API reads its data folder and its upload folder, relative to where it runs, at
      // start and stops when they are not there (aidm-api 2.6.1: TaskManager, Directories). In test
      // mode its data folder is tests/data.
      for (const folder of ["data", "tmp", ...((deps.extraArgs ?? []).includes("--test") ? [join("tests", "data")] : [])]) {
        mkdirSync(join(options.engineDataFolder, folder), { recursive: true });
      }
      this.writeConfig(options.hostPort, options.token, options.importFolders !== undefined ? parse(options.engineDataFolder).root : undefined);
    } catch {
      return fail("runtime.start_failed", { reason: "files" });
    }

    // The options are in the config file. Only its path is on the command line, which other users of the computer can read.
    const program = [this.executable, "--config", this.configFile, ...(deps.extraArgs ?? [])];
    // The task API has no memory flag. The limit has to come from the system, and only systemd gives one to a program that is not a container.
    const wrapped = options.memoryBytes !== null && deps.systemd();
    const scope = ["systemd-run", "--user", "--scope", "--quiet", "-p", `MemoryMax=${options.memoryBytes}`, "--", ...program];

    let started: SpawnedEngine;
    try {
      started = this.launch(wrapped ? scope : program, options.engineDataFolder);
    } catch (error) {
      return fail("runtime.start_failed", { reason: errorCode(error) ?? "spawn" });
    }
    let memoryCapEnforced: boolean | undefined;
    if (wrapped) {
      const endedAtOnce = await Promise.race([
        started.exited.then(() => true, () => true),
        Bun.sleep(deps.wrapWatchMs ?? WRAPPED_START_WATCH_MS).then(() => false),
      ]);
      if (endedAtOnce) {
        // The scope did not work (no user bus, no permission). The engine runs without a limit, and the view says so.
        deps.log(`Starting the engine inside a systemd scope failed (${this.leftBehind()}). It is started without a memory limit.`);
        deps.children.delete(started.pid);
        try {
          started = this.launch(program, options.engineDataFolder);
        } catch (error) {
          return fail("runtime.start_failed", { reason: errorCode(error) ?? "spawn" });
        }
        memoryCapEnforced = false;
      }
    }
    deps.settings.set("local.native", { pid: started.pid, port: options.hostPort, version: deps.version });
    return ok({ address: `http://127.0.0.1:${options.hostPort}`, memoryCapEnforced });
  }

  /** The options the task API reads with --config. Written whole and moved into place, readable by this user only. */
  private writeConfig(port: number, token: string, imagesRoot?: string): void {
    mkdirSync(dirname(this.configFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.configFile}.new`;
    rmSync(temporary, { force: true });
    const options = { token, port, parallelQueueProcessing: 1, odx_path: this.enginePath, ...(imagesRoot === undefined ? {} : { imagesRoot }) };
    writeFileSync(temporary, `${JSON.stringify(options)}\n`, { mode: 0o600 });
    renameSync(temporary, this.configFile);
  }

  /** Starts the program and notes it, so that this run of aidm-ui knows it is ours. */
  private launch(argv: string[], cwd: string): SpawnedEngine {
    const { deps } = this;
    // The API keeps its data and temporary folders relative to where it runs.
    const child = (deps.spawn ?? spawnEngine)(argv, { cwd, outputFile: this.outputFile });
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
    return child;
  }

  /** What a program that ended at once wrote to the output file, for the log. */
  private leftBehind(): string {
    try {
      return readFileSync(this.outputFile, "utf8").trim().slice(0, SCOPE_FAILURE_LOG_BYTES) || "no output";
    } catch {
      return "no output";
    }
  }

  /** Whether the recorded program is alive, as far as this run of aidm-ui can tell. */
  private alive(record: NativeProcess): boolean {
    const child = this.deps.children.get(record.pid);
    if (child !== undefined && child.exitCode !== null) return false;
    return isAlive(record.pid);
  }

  /**
   * A pid can be reused by another program, so the pid alone proves nothing.
   * The program is ours when it was started by this run of aidm-ui, or when
   * its command line names our config file. Nothing is sent to it: the token
   * goes only to a program that is known to be ours. A program that is ours is
   * ours whether or not it answers; one that is slow or busy is still the
   * engine and must not be left running unseen.
   */
  private async isOurs(record: NativeProcess): Promise<boolean> {
    const child = this.deps.children.get(record.pid);
    // Just after the start the command line may still be that of aidm-ui itself, so what this run started is not asked.
    if (child !== undefined && child.exitCode === null) return true;
    const line = await this.commandLine(record.pid);
    return line !== null && usesConfig(line, engineConfigFile(this.deps.dataFolder, record.version));
  }

  /** The command line of a process, or null when it cannot be read. */
  private async commandLine(pid: number): Promise<string | null> {
    try {
      if (process.platform === "linux") {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
      }
      const shown = await this.deps.runner.run(["ps", "-o", "args=", "-p", String(pid)]);
      return shown.exitCode === 0 ? shown.stdout : null;
    } catch {
      return null;
    }
  }

  async status(): Promise<PackageResult<PackageStatus>> {
    const record = this.deps.settings.get("local.native");
    if (record === null) return ok({ state: "missing", exitCode: null });
    const exitCode = this.deps.children.get(record.pid)?.exitCode ?? null;
    if (!this.alive(record)) return ok({ state: "stopped", exitCode });
    return ok((await this.isOurs(record)) ? { state: "running", exitCode: null } : { state: "stopped", exitCode: null });
  }

  /**
   * Ends our program and forgets it. A program that is not ours is left alone
   * and forgotten. One that is ours and survives is kept on record, so that
   * nothing starts a second engine next to it.
   */
  async stop(): Promise<PackageResult<void>> {
    const { deps } = this;
    const record = deps.settings.get("local.native");
    if (record === null) return ok(undefined);
    if (this.alive(record)) {
      if (!(await this.isOurs(record))) {
        // The pid belongs to another program now, so it is left alone.
        deps.log("A program with the recorded process number is not the engine, so it was not stopped.");
      } else if (!(await this.end(record))) {
        deps.log("The engine could not be stopped.");
        return fail("runtime.command_failed", { operation: "stop", reason: "still_running" });
      }
    }
    deps.children.delete(record.pid);
    deps.settings.set("local.native", null);
    return ok(undefined);
  }

  /**
   * SIGTERM to the program's whole process group, then SIGKILL if it is still
   * there after the grace. The command line is looked at again before SIGKILL:
   * the program may be gone and its number given to another. True when the
   * program is gone.
   */
  private async end(record: NativeProcess): Promise<boolean> {
    const grace = this.deps.stopGraceMs ?? STOP_GRACE_MS;
    this.signal(record.pid, "SIGTERM");
    if (await this.waitForExit(record, grace)) return true;
    if (!(await this.isOurs(record))) return true;
    this.deps.log("The engine did not stop when asked. It is ended by force.");
    this.signal(record.pid, "SIGKILL");
    return this.waitForExit(record, grace);
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    const send = this.deps.sendSignal ?? ((target: number, name: NodeJS.Signals) => process.kill(target, name));
    try {
      // The program leads a session of its own, so the group is the program and what it started.
      if (process.platform === "win32") send(pid, signal);
      else send(-pid, signal);
    } catch {
      try {
        send(pid, signal);
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
    if (options.tail === 0) reader.skipToEnd();
    else reader.lastLines(Math.min(options.tail ?? LOG_DEFAULT_TAIL_LINES, LOG_DEFAULT_TAIL_LINES));
    reader.pump();

    if (options.follow) {
      for (;;) {
        const record = this.deps.settings.get("local.native");
        const running = record !== null && this.alive(record);
        // One more look after the program ended, for what it wrote last.
        reader.pump();
        this.rotateOutput(reader);
        if (!running || options.signal?.aborted) break;
        await waitOrAbort(this.deps.logPollMs ?? LOG_POLL_MS, options.signal);
      }
    }
    reader.finish();
    return ok(undefined);
  }

  /**
   * The engine writes to a file that nothing else bounds. While aidm-ui follows
   * it, the file is copied to native-engine.out.1 (the older copies move up,
   * the oldest goes) and emptied once it passes the limit. The engine has the
   * file open for appending, so it goes on writing at the new end. Output
   * written between the copy and the emptying is lost, which the engine log
   * has already kept all but a moment of. A pipe to a small writer was the
   * other way, but that writer would end with aidm-ui, and the engine with it
   * on its next write.
   */
  private rotateOutput(reader: OutputReader): void {
    try {
      if (!existsSync(this.outputFile) || statSync(this.outputFile).size <= (this.deps.outputRotateBytes ?? OUTPUT_ROTATE_BYTES)) return;
      reader.pump();
      rmSync(`${this.outputFile}.${OUTPUT_KEPT_FILES}`, { force: true });
      for (let n = OUTPUT_KEPT_FILES - 1; n >= 1; n--) {
        if (existsSync(`${this.outputFile}.${n}`)) renameSync(`${this.outputFile}.${n}`, `${this.outputFile}.${n + 1}`);
      }
      copyFileSync(this.outputFile, `${this.outputFile}.1`);
      truncateSync(this.outputFile, 0);
      reader.restart();
    } catch (error) {
      this.deps.log(`The engine's output file could not be rotated: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The program is stopped and forgotten, and its folder stays. */
  async removeContainer(): Promise<PackageResult<void>> {
    return this.stop();
  }

  async remove(): Promise<PackageResult<void>> {
    rmSync(this.directory, { recursive: true, force: true });
    rmSync(this.configFile, { force: true });
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
  private decoder = new StringDecoder("utf8");
  private lines: ReturnType<typeof lineSplitter>;

  constructor(
    private readonly path: string,
    private readonly onLine: (line: string) => void,
  ) {
    this.lines = lineSplitter(onLine);
  }

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

  /** Starts again from the top of a file that was emptied. */
  restart(): void {
    this.offset = 0;
    this.decoder = new StringDecoder("utf8");
    this.lines = lineSplitter(this.onLine);
  }

  /**
   * Hands over the last `count` finished lines of the file. A line the program
   * is still writing is left for pump(). Reads no more than one chunk.
   */
  lastLines(count: number): void {
    const end = this.size();
    const start = Math.max(0, end - READ_CHUNK_BYTES);
    const bytes = this.readBytes(start, end);
    const lastBreak = bytes.lastIndexOf(0x0a);
    if (lastBreak === -1) {
      // No finished line. A line that fills the whole chunk is skipped; the start of the file is read by pump().
      this.offset = start > 0 ? end : 0;
      return;
    }
    // The read may begin inside a line, which is dropped.
    const from = start > 0 ? bytes.indexOf(0x0a) + 1 : 0;
    if (lastBreak < from) {
      this.offset = start + lastBreak + 1;
      return;
    }
    const found: string[] = [];
    const splitter = lineSplitter((line) => found.push(line));
    splitter.push(bytes.subarray(from, lastBreak + 1).toString("utf8"));
    splitter.end();
    for (const line of found.slice(-count)) this.onLine(line);
    this.offset = start + lastBreak + 1;
  }

  /** Reads what was added since the last call. */
  pump(): void {
    let end = this.size();
    // A new start empties the file.
    if (end < this.offset) this.restart();
    while (this.offset < end) {
      const to = Math.min(end, this.offset + READ_CHUNK_BYTES);
      const text = this.decoder.write(this.readBytes(this.offset, to));
      this.offset = to;
      this.lines.push(text);
      end = Math.max(end, this.size());
    }
  }

  /** Hands over a last line that had no line break. */
  finish(): void {
    this.lines.push(this.decoder.end());
    this.lines.end();
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
