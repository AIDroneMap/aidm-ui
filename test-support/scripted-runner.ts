import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "../server/process/command-runner.ts";

export interface ScriptedRule {
  argv: string[];
  result: CommandResult | ((argv: string[]) => CommandResult);
}

/** Answers commands from a list of rules, matched on the exact argument list. */
export class ScriptedRunner implements CommandRunner {
  readonly calls: string[][] = [];

  constructor(private readonly rules: ScriptedRule[]) {}

  run(argv: string[]): Promise<CommandResult> {
    this.calls.push(argv);
    const rule = this.rules.find(
      (candidate) => candidate.argv.length === argv.length && candidate.argv.every((part, i) => part === argv[i]),
    );
    if (rule === undefined) return Promise.resolve({ exitCode: 127, stdout: "", stderr: "not found" });
    return Promise.resolve(typeof rule.result === "function" ? rule.result(argv) : rule.result);
  }
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
