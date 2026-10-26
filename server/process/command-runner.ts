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

/** The shell's own codes for these two cases, so that callers read them the usual way. */
export const EXIT_NOT_FOUND = 127;
export const EXIT_TIMED_OUT = 124;

/** Runs real programs. A missing program is exit 127 and a program that outlives its time is killed and gives 124. */
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
        });
      } catch {
        return { exitCode: EXIT_NOT_FOUND, stdout: "", stderr: "not found" };
      }

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (timedOut) return { exitCode: EXIT_TIMED_OUT, stdout, stderr: stderr || "timed out" };
        return { exitCode, stdout, stderr };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
