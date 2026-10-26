import { FINISHED_RUN_STATES, RUN_STATES, type RunView } from "../../shared/api-types.ts";

/** The log lines the page keeps in memory; older ones are dropped. */
export const MAX_LOG_LINES = 2000;

export function isFinished(run: RunView): boolean {
  return FINISHED_RUN_STATES.includes(run.state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown, key: string): value is Record<string, number> {
  return isRecord(value) && typeof value[key] === "number" && typeof value["total"] === "number";
}

export function isRunView(value: unknown): value is RunView {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "number" &&
    (RUN_STATES as readonly unknown[]).includes(value["state"]) &&
    (value["step"] === null || value["step"] === "download" || value["step"] === "upload") &&
    (value["download"] === null || isCount(value["download"], "received")) &&
    (value["upload"] === null || isCount(value["upload"], "done")) &&
    (value["progress"] === null || typeof value["progress"] === "number") &&
    (value["engineMessage"] === null || typeof value["engineMessage"] === "string") &&
    (value["problem"] === null || isRecord(value["problem"])) &&
    typeof value["restarted"] === "boolean" &&
    (value["restartedAtLine"] === null || typeof value["restartedAtLine"] === "number") &&
    typeof value["resultsAvailable"] === "boolean"
  );
}

/** Reads the data of one "run" server-sent event. Returns null when it is not a run. */
export function parseRunEvent(data: string): RunView | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isRunView(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface LogLines {
  /** The newest lines, at most MAX_LOG_LINES. */
  lines: string[];
  /** How many lines the run has written so far, counting the dropped ones. */
  count: number;
}

export const EMPTY_LOG: LogLines = { lines: [], count: 0 };

/**
 * Adds lines that start at line number `from`. Lines already held are skipped, so
 * the same lines arriving twice (the backlog and a live event) are kept once.
 * When `from` is past what is held, a gap would show; the caller must ask for the
 * missing lines first, and nothing changes here.
 */
export function mergeLog(log: LogLines, from: number, incoming: string[]): LogLines {
  if (from > log.count) return log;
  const fresh = incoming.slice(log.count - from);
  if (fresh.length === 0) return log;
  return {
    lines: [...log.lines, ...fresh].slice(-MAX_LOG_LINES),
    count: log.count + fresh.length,
  };
}

/**
 * The lines to show, with the page's own separator where the engine's output
 * began again after a restart. The server writes no text of its own into the
 * log, so this is the only place the separator exists. No separator is drawn
 * when nothing came before it, or when the lines before it are no longer held.
 */
export function linesWithRestart(log: LogLines, restartedAtLine: number | null, separator: string): string[] {
  if (restartedAtLine === null || restartedAtLine <= 0) return log.lines;
  const at = restartedAtLine - (log.count - log.lines.length);
  if (at < 0 || at > log.lines.length) return log.lines;
  return [...log.lines.slice(0, at), separator, ...log.lines.slice(at)];
}

/** Reads the data of one "log" server-sent event. Returns null when it is not a block of lines. */
export function parseLogEvent(data: string): { lines: string[]; from: number } | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) return null;
    const { lines, from } = parsed;
    if (typeof from !== "number" || !Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
      return null;
    }
    return { lines: lines as string[], from };
  } catch {
    return null;
  }
}
