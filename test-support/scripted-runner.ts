import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT_ABORTED,
  type CommandResult,
  type CommandRunOptions,
  type CommandRunner,
  type CommandStreamOptions,
} from "../server/process/command-runner.ts";

export interface ScriptedRule {
  argv: string[];
  /** A function may wait, for example for the signal of a streamed call to fire. */
  result: CommandResult | ((argv: string[], signal?: AbortSignal) => CommandResult | Promise<CommandResult>);
}

/** Answers commands from a list of rules, matched on the exact argument list. */
export class ScriptedRunner implements CommandRunner {
  readonly calls: string[][] = [];
  /** The time limit each call was given, in the order of `calls`; undefined where the call set none. */
  readonly timeouts: Array<number | undefined> = [];

  constructor(private readonly rules: ScriptedRule[]) {}

  run(argv: string[], options: CommandRunOptions = {}): Promise<CommandResult> {
    return this.answer(argv, options.timeoutMs);
  }

  /** Replays the answer's stdout lines, then its stderr lines, through onLine; the result keeps only the exit code. */
  async stream(argv: string[], options: CommandStreamOptions): Promise<CommandResult> {
    // Like the real runner, a signal that fired before the start runs nothing.
    if (options.signal?.aborted) return { exitCode: EXIT_ABORTED, stdout: "", stderr: "" };
    const result = await this.answer(argv, options.timeoutMs, options.signal);
    if (result.exitCode !== 127 || result.stderr !== "not found") {
      for (const line of linesOf(result.stdout)) options.onLine(line, "stdout");
      for (const line of linesOf(result.stderr)) options.onLine(line, "stderr");
    }
    return {
      exitCode: result.exitCode,
      stdout: "",
      stderr: "",
      ...(result.spawnFailure === undefined ? {} : { spawnFailure: result.spawnFailure }),
    };
  }

  private async answer(argv: string[], timeoutMs?: number, signal?: AbortSignal): Promise<CommandResult> {
    this.calls.push(argv);
    this.timeouts.push(timeoutMs);
    const rule = this.rules.find(
      (candidate) => candidate.argv.length === argv.length && candidate.argv.every((part, i) => part === argv[i]),
    );
    if (rule === undefined) return { exitCode: 127, stdout: "", stderr: "not found", spawnFailure: "not_found" };
    return typeof rule.result === "function" ? rule.result(argv, signal) : rule.result;
  }
}

function linesOf(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

const RECORDED = join(import.meta.dir, "recorded");

/** The text of a recorded file, such as cpuinfo/x86-64-avx2. */
export function recordedText(tool: string, name: string): string {
  return readFileSync(join(RECORDED, tool, `${name}.txt`), "utf8");
}

/**
 * A recorded command output: the stdout in tool/name.txt, and the exit code
 * and stderr from tool/name.json when that file exists (otherwise 0 and empty).
 */
export function recorded(tool: string, name: string): CommandResult {
  const stdout = recordedText(tool, name);
  const sidecar = join(RECORDED, tool, `${name}.json`);
  if (!existsSync(sidecar)) return { exitCode: 0, stdout, stderr: "" };
  const { exitCode, stderr } = JSON.parse(readFileSync(sidecar, "utf8")) as { exitCode: number; stderr: string };
  return { exitCode, stdout, stderr };
}
