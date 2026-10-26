export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Set only when the program could not be started at all, so the exit code is
   * the runner's own and not the program's. A caller that must tell a missing
   * program from one that exited with 127 or 126 reads this.
   */
  spawnFailure?: "not_found" | "cannot_run";
}

export interface CommandRunOptions {
  /** Default 15 seconds. */
  timeoutMs?: number;
  /** Added to this process's environment, or the whole environment when `inheritEnv` is false. */
  env?: Record<string, string>;
  /** Default true. False starts the program with `env` alone, and the program is looked up on that PATH. */
  inheritEnv?: boolean;
}

export interface CommandStreamOptions {
  /** Called for each line as it arrives, without the line break. */
  onLine: (line: string, from: "stdout" | "stderr") => void;
  /** Stops the program. The call then returns with the program's exit code. */
  signal?: AbortSignal;
  /** No limit when absent, because a pull can take an hour. */
  timeoutMs?: number;
}

/** The one way the server starts other programs, so that tests can answer for them. */
export interface CommandRunner {
  run(argv: string[], options?: CommandRunOptions): Promise<CommandResult>;
  /**
   * Like run, but hands over each line of output as it arrives. The lines went
   * to onLine, so the result's stdout and stderr are empty.
   */
  stream(argv: string[], options: CommandStreamOptions): Promise<CommandResult>;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

/** The shell's own codes for these cases, so that callers read them the usual way. */
export const EXIT_NOT_FOUND = 127;
export const EXIT_TIMED_OUT = 124;
/** The program is there but could not be started, for example because it is not executable. */
export const EXIT_CANNOT_RUN = 126;
/** A streamed call whose signal fired before the program started. */
export const EXIT_ABORTED = 130;

/** The argument list with the value after --token hidden, in both the "--token value" and the "--token=value" form. */
export function hideTokenArguments(argv: string[]): string[] {
  return argv.map((part, index) => {
    if (argv[index - 1] === "--token") return "***";
    return part.startsWith("--token=") ? "--token=***" : part;
  });
}

/** A command line fit for a log: the value after --token is hidden. */
export function describeCommand(argv: string[]): string {
  return hideTokenArguments(argv).join(" ");
}

/** A line longer than this many characters (64 KiB for plain text) is handed over in pieces, so a program that never breaks its lines cannot fill the memory. */
export const MAX_LINE_LENGTH = 64 * 1024;

/** Cuts a stream of text into lines, holding back the last partial line until the next chunk or the end. */
function lineSplitter(onLine: (line: string) => void): { push(text: string): void; end(): void } {
  let pending = "";
  const emit = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  return {
    push(text) {
      pending += text;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline !== -1 && newline <= MAX_LINE_LENGTH) {
          emit(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        } else if (pending.length > MAX_LINE_LENGTH) {
          emit(pending.slice(0, MAX_LINE_LENGTH));
          pending = pending.slice(MAX_LINE_LENGTH);
        } else {
          return;
        }
      }
    },
    end() {
      if (pending !== "") emit(pending);
      pending = "";
    },
  };
}

/** Each of stdout and stderr keeps this much; the rest is read and dropped. */
export const OUTPUT_CAP_BYTES = 4 * 1024 * 1024;
/** After the program ends, how long to wait for output that a background program still holds open. */
export const OUTPUT_GRACE_MS = 500;

interface Capture {
  /** Resolves when the stream has ended. */
  done: Promise<void>;
  /** What was kept so far. */
  text(): string;
  stop(): void;
}

function capture(stream: ReadableStream<Uint8Array>): Capture {
  const reader = stream.getReader();
  const kept: Uint8Array[] = [];
  let size = 0;
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        // Keep reading after the cap so that the program never blocks on a full pipe.
        if (size < OUTPUT_CAP_BYTES) {
          const part = chunk.value.subarray(0, OUTPUT_CAP_BYTES - size);
          kept.push(part);
          size += part.length;
        }
      }
    } catch {
      // A stream that was cancelled or broke keeps what it had.
    }
  })();
  return {
    done,
    text: () => new TextDecoder().decode(Buffer.concat(kept)),
    stop: () => void reader.cancel().catch(() => {}),
  };
}

interface LineReader {
  /** Resolves when the stream has ended. */
  done: Promise<void>;
  stop(): void;
}

function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): LineReader {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines = lineSplitter(onLine);
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        lines.push(decoder.decode(chunk.value, { stream: true }));
      }
      lines.push(decoder.decode());
    } catch {
      // A stream that was cancelled or broke keeps what it gave.
    }
    lines.end();
  })();
  return { done, stop: () => void reader.cancel().catch(() => {}) };
}

/** After the program ends, waits for its output, but not longer than the grace for a background program that holds the pipes. */
async function drain(readers: Array<{ done: Promise<void>; stop(): void }>): Promise<void> {
  let grace: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(readers.map((reader) => reader.done)),
    new Promise<void>((resolve) => {
      grace = setTimeout(resolve, OUTPUT_GRACE_MS);
    }),
  ]);
  clearTimeout(grace);
  for (const reader of readers) reader.stop();
}

/** The program and everything it started: the child leads its own process group. */
function killGroup(proc: Bun.Subprocess): void {
  try {
    if (process.platform === "win32") proc.kill("SIGKILL");
    else process.kill(-proc.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

/**
 * The environment and the program to start. With an environment of its own the
 * program is looked up on that PATH and not on ours, so the lookup cannot be
 * steered by what this process inherited.
 */
function launchPlan(argv: string[], options: CommandRunOptions): { argv: string[]; env: Record<string, string | undefined> } | null {
  if (options.inheritEnv !== false) return { argv, env: { ...process.env, ...options.env } };
  const env = { ...options.env };
  const program = argv[0] ?? "";
  if (program.includes("/")) return { argv, env };
  const found = Bun.which(program, { PATH: env["PATH"] ?? "" });
  return found === null ? null : { argv: [found, ...argv.slice(1)], env };
}

/**
 * Runs real programs. A missing program is exit 127, one that cannot be started
 * is 126, and one that outlives its time is killed with everything it started
 * and gives 124.
 */
export function systemRunner(): CommandRunner {
  return {
    async run(argv, options = {}) {
      const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
      let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try {
        const plan = launchPlan(argv, options);
        if (plan === null) return { exitCode: EXIT_NOT_FOUND, stdout: "", stderr: "not found", spawnFailure: "not_found" };
        proc = Bun.spawn(plan.argv, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: plan.env,
          detached: true,
        });
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return { exitCode: EXIT_NOT_FOUND, stdout: "", stderr: "not found", spawnFailure: "not_found" };
        }
        return {
          exitCode: EXIT_CANNOT_RUN,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          spawnFailure: "cannot_run",
        };
      }

      const out = capture(proc.stdout);
      const err = capture(proc.stderr);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(proc);
      }, timeoutMs);
      let exitCode: number;
      try {
        exitCode = await proc.exited;
      } finally {
        clearTimeout(timer);
      }
      // A background program can keep the pipes open after the program itself is gone.
      await drain([out, err]);

      const stdout = out.text();
      const stderr = err.text();
      if (timedOut) return { exitCode: EXIT_TIMED_OUT, stdout, stderr: stderr || "timed out" };
      return { exitCode, stdout, stderr };
    },
    async stream(argv, options) {
      if (options.signal?.aborted) return { exitCode: EXIT_ABORTED, stdout: "", stderr: "" };
      let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try {
        proc = Bun.spawn(argv, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
          detached: true,
        });
      } catch (error) {
        if (errorCode(error) === "ENOENT") return { exitCode: EXIT_NOT_FOUND, stdout: "", stderr: "", spawnFailure: "not_found" };
        options.onLine(error instanceof Error ? error.message : String(error), "stderr");
        return { exitCode: EXIT_CANNOT_RUN, stdout: "", stderr: "", spawnFailure: "cannot_run" };
      }

      const out = readLines(proc.stdout, (line) => options.onLine(line, "stdout"));
      const err = readLines(proc.stderr, (line) => options.onLine(line, "stderr"));
      let timedOut = false;
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              killGroup(proc);
            }, options.timeoutMs);
      const abort = () => killGroup(proc);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      try {
        const exitCode = await proc.exited;
        await drain([out, err]);
        return { exitCode: timedOut ? EXIT_TIMED_OUT : exitCode, stdout: "", stderr: "" };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      }
    },
  };
}
