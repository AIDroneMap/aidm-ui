import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What one finished run did on its engine, for the one line the diagnosis log
 * gets at the end of every run, so an operator can send one file with a bug
 * report. The figures come from the engine's own log.json when aidm-ui can
 * read it (the local engine keeps it in the engine data folder), else from
 * the task output aidm-ui received.
 */
export interface RunSummary {
  /** "log.json": the engine's own figures. "output": counted in the task output, with stage times as aidm-ui saw them. */
  source: "log.json" | "output";
  stages: Array<{ name: string; seconds: number | null }>;
  warnings: number;
  /** Null where the source cannot say: the task output does not carry exit codes. */
  failedProcesses: number | null;
  /** The engine's total time in seconds, null when it did not say. */
  engineSeconds: number | null;
}

/** A time of log.json, which the engine writes as its local time without a zone: only differences are used. */
function secondsOf(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?/.exec(text);
  if (parts === null) return null;
  const [, y, mo, d, h, mi, s, fraction] = parts.map((part) => part ?? "0");
  const whole = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000;
  return whole + Number(`0.${fraction ?? "0"}`);
}

const round = (seconds: number) => Math.round(seconds * 10) / 10;

/** The figures of the engine's log.json (aidm: modules/log.py), or null for anything else. */
export function summaryFromLogJson(text: string): RunSummary | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const root = json as { stages?: unknown; processes?: unknown; totalTime?: unknown; endTime?: unknown } | null;
  if (root === null || typeof root !== "object" || !Array.isArray(root.stages)) return null;
  const stages = root.stages as Array<{ name?: unknown; startTime?: unknown; totalTime?: unknown; messages?: unknown }>;
  const end = secondsOf(root.endTime);
  const timed = stages.map((stage, index) => {
    const name = typeof stage.name === "string" ? stage.name : "?";
    // The last stage carries its own time. Each other one runs until the next one starts.
    if (index === stages.length - 1 && typeof stage.totalTime === "number") return { name, seconds: round(stage.totalTime) };
    const start = secondsOf(stage.startTime);
    const until = index + 1 < stages.length ? secondsOf(stages[index + 1]?.startTime) : end;
    return { name, seconds: start === null || until === null ? null : round(Math.max(0, until - start)) };
  });
  const warnings = stages.reduce(
    (sum, stage) => sum + (Array.isArray(stage.messages) ? stage.messages.filter((message) => (message as { type?: unknown } | null)?.type === "warning").length : 0),
    0,
  );
  const processes = Array.isArray(root.processes) ? (root.processes as Array<{ exitCode?: unknown }>) : [];
  return {
    source: "log.json",
    stages: timed,
    warnings,
    failedProcesses: processes.filter((process) => typeof process.exitCode === "number" && process.exitCode !== 0).length,
    engineSeconds: typeof root.totalTime === "number" ? round(root.totalTime) : null,
  };
}

/** The figures the task output gives: its warnings, and the stages with the times at which aidm-ui first saw them start. */
export function summaryFromOutput(lines: string[], stageSeen: Array<{ name: string; at: number }>, endedAt: number, engineMs: number | null): RunSummary {
  return {
    source: "output",
    stages: stageSeen.map((stage, index) => ({ name: stage.name, seconds: round(((stageSeen[index + 1]?.at ?? endedAt) - stage.at) / 1000) })),
    warnings: lines.filter((line) => line.trimStart().startsWith("[WARNING]")).length,
    failedProcesses: null,
    engineSeconds: engineMs === null || engineMs < 0 ? null : round(engineMs / 1000),
  };
}

/** The name of the stage a line of the engine's output starts, if it starts one (aidm: modules/types.py, "Running %s stage"). */
export function stageStarted(line: string): string | null {
  return /^\s*\[INFO\]\s+Running (\S+) stage\s*$/.exec(line)?.[1] ?? null;
}

/** The engine's log.json in a task's folder, when aidm-ui can read it there. */
export function readLogJson(taskFolder: string | null): RunSummary | null {
  if (taskFolder === null) return null;
  const file = join(taskFolder, "log.json");
  try {
    return existsSync(file) ? summaryFromLogJson(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

/** The one line of the diagnosis log. */
export function summaryLine(run: { id: number; state: string; engineName: string }, summary: RunSummary, where: string): string {
  const stages = summary.stages.map((stage) => `${stage.name} ${stage.seconds === null ? "?" : `${stage.seconds} s`}`).join(", ");
  const from = summary.source === "log.json" ? "from the engine's log.json" : "as AIDM UI's polls saw them, to within a poll";
  return [
    `Run ${run.id} summary: ${run.state} on "${run.engineName}"`,
    `the engine took ${summary.engineSeconds === null ? "an unknown time" : `${summary.engineSeconds} s`}`,
    `stages (${from}): ${stages === "" ? "none seen" : stages}`,
    `${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}`,
    summary.failedProcesses === null ? "failed processes not known from the output" : `${summary.failedProcesses} failed process${summary.failedProcesses === 1 ? "" : "es"}`,
    `the engine's task log: ${where}`,
  ].join("; ");
}
