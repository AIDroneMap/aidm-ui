export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunOptions {
  /** Default 15 seconds. */
  timeoutMs?: number;
  /** Added to this process's environment. */
  env?: Record<string, string>;
}

/** The one way the server starts other programs, so that tests can answer for them. */
export interface CommandRunner {
  run(argv: string[], options?: CommandRunOptions): Promise<CommandResult>;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

/** The shell's own codes for these cases, so that callers read them the usual way. */
export const EXIT_NOT_FOUND = 127;
export const EXIT_TIMED_OUT = 124;
/** The program is there but could not be started, for example because it is not executable. */
export const EXIT_CANNOT_RUN = 126;

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
        proc = Bun.spawn(argv, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...options.env },
          detached: true,
        });
      } catch (error) {
        if (errorCode(error) === "ENOENT") return { exitCode: EXIT_NOT_FOUND, stdout: "", stderr: "not found" };
        return { exitCode: EXIT_CANNOT_RUN, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
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
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([out.done, err.done]),
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, OUTPUT_GRACE_MS);
        }),
      ]);
      clearTimeout(grace);
      out.stop();
      err.stop();

      const stdout = out.text();
      const stderr = err.text();
      if (timedOut) return { exitCode: EXIT_TIMED_OUT, stdout, stderr: stderr || "timed out" };
      return { exitCode, stdout, stderr };
    },
  };
}
