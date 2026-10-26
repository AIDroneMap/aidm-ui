import type { CommandResult, CommandRunOptions, CommandRunner } from "../server/process/command-runner.ts";
import type { PrivilegedRunner } from "../server/runtimes/podman-setup.ts";
import type { SystemFiles } from "../server/runtimes/setup-command.ts";

/** A privileged runner that never asks anyone: it records every call and answers from a function. */
export class FakePrivilegedRunner implements PrivilegedRunner {
  readonly calls: string[][] = [];

  /** `answer` gets the arguments and a function that says a line of output, as the real command does after the approval. */
  constructor(
    private answer: (argv: string[], say: (line: string) => void) => Promise<CommandResult> | CommandResult = () => ({
      exitCode: 127,
      stdout: "",
      stderr: "",
    }),
  ) {}

  /** Changes what the next calls answer. */
  answerWith(answer: (argv: string[], say: (line: string) => void) => Promise<CommandResult> | CommandResult): void {
    this.answer = answer;
  }

  async runAsRoot(argv: string[], onLine?: (line: string) => void): Promise<CommandResult> {
    this.calls.push(argv);
    return this.answer(argv, (line) => onLine?.(line));
  }
}

export function exited(exitCode: number): CommandResult {
  return { exitCode, stdout: "", stderr: "" };
}

/** Files in memory that remember every path they were asked for. */
export class FakeSystemFiles implements SystemFiles {
  readonly reads: string[] = [];

  constructor(public files: Record<string, string | null> = {}) {}

  readFile(path: string): string | null {
    this.reads.push(path);
    return this.files[path] ?? null;
  }
}

/** A command runner that records every command with its environment and answers exit 0 unless told otherwise. */
export class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ argv: string[]; env: Record<string, string> | undefined }> = [];

  constructor(private readonly answer: (argv: string[]) => CommandResult = () => exited(0)) {}

  get argvs(): string[][] {
    return this.calls.map((call) => call.argv);
  }

  async run(argv: string[], options?: CommandRunOptions): Promise<CommandResult> {
    this.calls.push({ argv, env: options?.env });
    return this.answer(argv);
  }

  async stream(argv: string[]): Promise<CommandResult> {
    this.calls.push({ argv, env: undefined });
    return this.answer(argv);
  }
}
