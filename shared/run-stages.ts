import { FINISHED_RUN_STATES, type RunState } from "./api-types.ts";

/** The engine's stages in the order it runs them. */
export const RUN_STAGES = ["dataset", "split", "merge", "opensfm", "openmvs", "odm_filterpoints", "odm_meshing", "mvs_texturing", "odm_georeferencing", "odm_dem", "odm_orthophoto", "odm_report", "odm_postprocess"] as const;
export type RunStage = (typeof RUN_STAGES)[number];

/** Split and merge run only for a split flight, so they are listed only when the engine announces them. */
const ANNOUNCED_ONLY: readonly RunStage[] = ["split", "merge"];

export type RunStageState = "waiting" | "running" | "done" | "skipped" | "failed";

/** One stage of the run screen's list. */
export interface RunStageView {
  name: RunStage;
  state: RunStageState;
  /** When aidm-ui first saw the engine announce the stage, ISO 8601. Null when the stage was not seen, or was seen before aidm-ui kept the times. */
  startedAt: string | null;
}

/** A line of the engine's log that starts a stage, with its line number in the run's log and when aidm-ui saw it. */
export interface StageAnnouncement {
  name: string;
  line: number;
  at: string | null;
}

/** Where a failed run stopped: the stage, and the last lines of its log with the first error among them. */
export interface RunFailureView {
  /** The stage the engine was in when the run failed, or null when it had announced none. */
  stage: RunStage | null;
  /** The first line of the excerpt, as a line number of the run's log. */
  from: number;
  /** The line after the excerpt's last one. */
  to: number;
  /** The line number of the first error in the excerpt, or null when no line reads as one. */
  errorLine: number | null;
}

/** How many of the last log lines a failed run shows. */
export const FAILURE_LINES = 40;

/** The name of the stage a line of the engine's output starts, if it starts one (aidm: modules/types.py, "Running %s stage"). */
export function stageStarted(line: string): string | null {
  return /^\s*\[INFO\]\s+Running (\S+) stage\s*$/.exec(line)?.[1] ?? null;
}

function isStage(name: string): name is RunStage {
  return (RUN_STAGES as readonly string[]).includes(name);
}

/**
 * The stage list of a run, from the stages its log announced since the
 * engine's latest start. Nothing is estimated: a stage is done only when a
 * later one started or the run completed, and a stage the engine never
 * announced is skipped once the engine has gone past it or the run ended.
 */
export function stagesOf(announced: readonly StageAnnouncement[], restartedAtLine: number | null, state: RunState): RunStageView[] {
  const current = announced.filter((item) => item.line >= (restartedAtLine ?? 0)).sort((a, b) => a.line - b.line);
  const firstSeen = new Map<RunStage, StageAnnouncement>();
  for (const item of current) if (isStage(item.name) && !firstSeen.has(item.name)) firstSeen.set(item.name, item);
  // A stage this list does not know means the engine went past the last one it does, so none is current.
  const latest = current.at(-1)?.name ?? null;
  const last = latest !== null && isStage(latest) ? latest : null;
  const known = current.filter((item) => isStage(item.name)).at(-1)?.name as RunStage | undefined;
  const lastIndex = known === undefined ? -1 : RUN_STAGES.indexOf(known);
  const finished = FINISHED_RUN_STATES.includes(state);
  return RUN_STAGES.filter((name) => !ANNOUNCED_ONLY.includes(name) || firstSeen.has(name)).map((name) => {
    const seen = firstSeen.get(name);
    let stageState: RunStageState;
    if (name === last) stageState = state === "completed" ? "done" : state === "failed" ? "failed" : state === "cancelled" ? "skipped" : "running";
    else if (seen) stageState = "done";
    else if (finished || RUN_STAGES.indexOf(name) < lastIndex) stageState = "skipped";
    else stageState = "waiting";
    return { name, state: stageState, startedAt: seen?.at ?? null };
  });
}

/**
 * The run's elapsed time in milliseconds: the engine's own processing time
 * once it reports one, before that the time since the run was created. A
 * finished run the engine never processed has none.
 */
export function elapsedOf(run: { state: RunState; processingTime: number | null; createdAt: string }, now: number): number | null {
  if (run.processingTime !== null && run.processingTime >= 0) return run.processingTime;
  if (FINISHED_RUN_STATES.includes(run.state)) return null;
  const created = Date.parse(run.createdAt);
  return Number.isNaN(created) ? null : Math.max(0, now - created);
}

/** The lines a failed run shows: the last FAILURE_LINES of the engine's latest start. */
export function failureRange(lineCount: number, restartedAtLine: number | null): { from: number; to: number } {
  const start = Math.min(lineCount, Math.max(0, restartedAtLine ?? 0));
  return { from: Math.max(start, lineCount - FAILURE_LINES), to: lineCount };
}

/** A line that reports an error: the engine's own error lines and Python's traceback and exception lines. */
export function isErrorLine(line: string): boolean {
  return /^\s*(\[ERROR\]|Traceback \(most recent call last\)|[A-Za-z_][\w.]*(Error|Exception)\b)/.test(line);
}

/** Where a failed run stopped, from its stages and the lines of its failure range. */
export function failureOf(stages: readonly RunStageView[], range: { from: number; to: number }, lines: readonly string[]): RunFailureView {
  const index = lines.findIndex(isErrorLine);
  return {
    stage: stages.find((stage) => stage.state === "failed")?.name ?? null,
    from: range.from,
    to: range.to,
    errorLine: index === -1 ? null : range.from + index,
  };
}
