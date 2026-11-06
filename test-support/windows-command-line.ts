import type { CommandResult, CommandRunner } from "../server/process/command-runner.ts";
import { runnerWithSystemd } from "./native-archive.ts";

// Builds a Windows command line from an argument list, the way a program that
// starts another one on Windows quotes it: an argument with a space, a tab or a
// quote is put in quotes, a quote in it is escaped, and the backslashes before
// a quote or before the closing quote are doubled. Tests use it to answer for
// the system, as Windows would show the command line of the task API.

export function windowsCommandLine(argv: string[]): string {
  return argv.map((arg, index) => (index === 0 ? quoteProgram(arg) : quoteArgument(arg))).join(" ");
}

function quoteProgram(program: string): string {
  return /[ \t]/.test(program) ? `"${program}"` : program;
}

function quoteArgument(arg: string): string {
  if (arg !== "" && !/[ \t"]/.test(arg)) return arg;
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    quoted += "\\".repeat(char === '"' ? backslashes * 2 + 1 : backslashes) + char;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * A runner that answers for PowerShell and taskkill as Windows would, and
 * hands every other program to `real` (default: the real programs, and no
 * systemd). PowerShell's question for the command line of a process gets
 * `commandLine(pid)`, quoted the Windows way, or nothing for a process it does
 * not know. Taskkill ends the process and its group, as /T ends the tree,
 * unless `taskkillEnds` is false. `calls` keeps every call it answered.
 */
export function windowsRunner(options: {
  commandLine: (pid: number) => string[] | undefined;
  taskkillEnds?: boolean;
  real?: CommandRunner;
}): CommandRunner & { calls: Array<{ argv: string[]; timeoutMs: number | undefined }> } {
  const real = options.real ?? runnerWithSystemd(false);
  const calls: Array<{ argv: string[]; timeoutMs: number | undefined }> = [];
  const answer = (argv: string[]): CommandResult | null => {
    if (argv[0] === "powershell") {
      const line = options.commandLine(Number(/ProcessId = (\d+)/.exec(argv.at(-1) ?? "")?.[1]));
      return { exitCode: 0, stdout: line === undefined ? "" : `${windowsCommandLine(line)}\r\n`, stderr: "" };
    }
    if (argv[0] === "taskkill") {
      const pid = Number(argv[argv.indexOf("/PID") + 1]);
      if (options.taskkillEnds !== false) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      return { exitCode: 0, stdout: `SUCCESS: The process with PID ${pid} (child process of PID 1) has been terminated.\r\n`, stderr: "" };
    }
    return null;
  };
  return {
    calls,
    run: (argv, runOptions) => {
      const answered = answer(argv);
      if (answered === null) return real.run(argv, runOptions);
      calls.push({ argv, timeoutMs: runOptions?.timeoutMs });
      return Promise.resolve(answered);
    },
    stream: (argv, streamOptions) => real.stream(argv, streamOptions),
  };
}
