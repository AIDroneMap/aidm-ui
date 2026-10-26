import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult, CommandRunner, CommandStreamOptions } from "../server/process/command-runner.ts";

export interface ScriptedRule {
  argv: string[];
  result: CommandResult | ((argv: string[]) => CommandResult);
}

/** Answers commands from a list of rules, matched on the exact argument list. */
export class ScriptedRunner implements CommandRunner {
  readonly calls: string[][] = [];

  constructor(private readonly rules: ScriptedRule[]) {}

  run(argv: string[]): Promise<CommandResult> {
    return Promise.resolve(this.answer(argv));
  }

  /** Replays the answer's stdout lines, then its stderr lines, through onLine; the result keeps only the exit code. */
  stream(argv: string[], options: CommandStreamOptions): Promise<CommandResult> {
    const result = this.answer(argv);
    if (result.exitCode !== 127 || result.stderr !== "not found") {
      for (const line of linesOf(result.stdout)) options.onLine(line, "stdout");
      for (const line of linesOf(result.stderr)) options.onLine(line, "stderr");
    }
    return Promise.resolve({ exitCode: result.exitCode, stdout: "", stderr: "" });
  }

  private answer(argv: string[]): CommandResult {
    this.calls.push(argv);
    const rule = this.rules.find(
      (candidate) => candidate.argv.length === argv.length && candidate.argv.every((part, i) => part === argv[i]),
    );
    if (rule === undefined) return { exitCode: 127, stdout: "", stderr: "not found" };
    return typeof rule.result === "function" ? rule.result(argv) : rule.result;
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
