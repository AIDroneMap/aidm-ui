import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EnginePackage } from "../packages/engine-package.ts";

export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
export const LOG_KEPT_FILES = 3;
/** The lines a new listener gets at once. */
export const LOG_MEMORY_LINES = 500;
const RETRY_BACKOFF_MS = 1000;
/** A line longer than this many bytes is cut, so one runaway line cannot fill the file or the page. */
export const LOG_LINE_MAX_BYTES = 4 * 1024;
const LINE_CUT_MARK = "...";
/** Reading the tail of the file at start never takes more than this. */
const TAIL_READ_BYTES = 256 * 1024;

export interface EngineLogDeps {
  dataFolder: string;
  /** The token of the running engine, so a line that holds it can be cleaned. */
  token: () => string | null;
  log: (line: string) => void;
  rotateBytes?: number;
  retryBackoffMs?: number;
}

/**
 * Follows the engine's log. Every line goes to a rotated file in the data
 * folder and to whoever listens in the browser; the last lines are kept for
 * those who join later.
 */
export class EngineLog {
  private readonly file: string;
  private readonly rotateBytes: number;
  private readonly retryBackoffMs: number;
  private readonly recent: string[];
  private readonly listeners = new Set<(lines: string[]) => void>();
  private size = 0;
  private following: { abort: AbortController; done: Promise<void> } | undefined;

  constructor(private readonly deps: EngineLogDeps) {
    const folder = join(deps.dataFolder, "logs");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.file = join(folder, "engine.log");
    this.rotateBytes = deps.rotateBytes ?? LOG_ROTATE_BYTES;
    this.retryBackoffMs = deps.retryBackoffMs ?? RETRY_BACKOFF_MS;
    this.size = existsSync(this.file) ? statSync(this.file).size : 0;
    this.recent = this.readTail();
  }

  /** The last lines, oldest first. */
  lines(): string[] {
    return [...this.recent];
  }

  /** The listener gets each batch of new lines. It returns the way to stop listening. */
  subscribe(listener: (lines: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isFollowing(): boolean {
    return this.following !== undefined;
  }

  /**
   * Follows the log of a package until stop(). A stream that ends while the
   * engine still runs is opened again after a short wait. `fresh` says the
   * container is new, so its whole log is wanted; otherwise only what comes next.
   */
  follow(pkg: EnginePackage, options: { fresh: boolean }): void {
    if (this.following !== undefined) return;
    const abort = new AbortController();
    const entry = { abort, done: Promise.resolve() };
    entry.done = this.loop(pkg, abort.signal, options.fresh).finally(() => {
      if (this.following === entry) this.following = undefined;
    });
    this.following = entry;
  }

  /** Stops following and waits for the stream to end. The container is left alone. */
  async stop(): Promise<void> {
    const current = this.following;
    if (current === undefined) return;
    current.abort.abort();
    await current.done;
  }

  private async loop(pkg: EnginePackage, signal: AbortSignal, fresh: boolean): Promise<void> {
    let first = fresh;
    while (!signal.aborted) {
      try {
        const result = await pkg.logs({
          follow: true,
          tail: first ? undefined : 0,
          signal,
          onLine: (line) => this.add(line),
        });
        if (!result.ok) this.deps.log(`The engine log could not be followed (${result.error.code}).`);
      } catch (error) {
        this.deps.log(`Following the engine log failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      first = false;
      if (signal.aborted) return;
      // The stream ended. Open it again only while the container is still there to ask.
      let running = false;
      try {
        const status = await pkg.status();
        running = status.ok && status.value.state === "running";
      } catch {
        running = false;
      }
      if (!running) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.retryBackoffMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  private clean(line: string): string {
    const token = this.deps.token();
    return token === null || token === "" ? line : line.split(token).join("[token]");
  }

  /** The line as it is kept: at most LOG_LINE_MAX_BYTES, cut on a character boundary and marked. */
  private shorten(line: string): string {
    if (Buffer.byteLength(line) <= LOG_LINE_MAX_BYTES) return line;
    const bytes = Buffer.from(line);
    let end = LOG_LINE_MAX_BYTES - LINE_CUT_MARK.length;
    // A byte of the form 10xxxxxx continues a character, so the cut moves back to where that character began.
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8") + LINE_CUT_MARK;
  }

  private add(raw: string): void {
    // Cleaned before it is cut, so a token never survives as a piece of itself.
    const line = this.shorten(this.clean(raw));
    this.recent.push(line);
    if (this.recent.length > LOG_MEMORY_LINES) this.recent.splice(0, this.recent.length - LOG_MEMORY_LINES);
    this.write(line);
    for (const listener of [...this.listeners]) {
      try {
        listener([line]);
      } catch (error) {
        this.deps.log(`A log listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private write(line: string): void {
    try {
      const bytes = Buffer.byteLength(line) + 1;
      if (this.size > 0 && this.size + bytes > this.rotateBytes) this.rotate();
      appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
      this.size += bytes;
    } catch (error) {
      this.deps.log(`The engine log file could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** engine.log becomes engine.log.1, .1 becomes .2, and so on; the oldest goes. */
  private rotate(): void {
    rmSync(`${this.file}.${LOG_KEPT_FILES}`, { force: true });
    for (let n = LOG_KEPT_FILES - 1; n >= 1; n--) {
      if (existsSync(`${this.file}.${n}`)) renameSync(`${this.file}.${n}`, `${this.file}.${n + 1}`);
    }
    renameSync(this.file, `${this.file}.1`);
    this.size = 0;
  }

  /** The last lines of the file from an earlier run of aidm-ui. */
  private readTail(): string[] {
    try {
      const bytes = readFileSync(this.file);
      const text = bytes.subarray(Math.max(0, bytes.length - TAIL_READ_BYTES)).toString("utf8");
      const lines = text.split("\n");
      // The first line may be cut by the read.
      if (bytes.length > TAIL_READ_BYTES) lines.shift();
      if (lines.at(-1) === "") lines.pop();
      return lines.slice(-LOG_MEMORY_LINES);
    } catch {
      return [];
    }
  }
}
