import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunLogView, RunView } from "../../shared/api-types.ts";
import type { EngineStore } from "../engines/engine-store.ts";
import { isTaskNotFound, TaskClient, type EngineEndpoint, type TaskApiFailure, type TaskApiResult } from "../task-api/task-client.ts";
import { isFinished, runStateFromTask } from "./run-state.ts";
import type { RunPatch, RunRecord, RunStore } from "./run-store.ts";

export const DEFAULT_RUN_POLL_INTERVAL_MS = 2000;
/** After this many polls in a row without an answer the run shows the engine as unreachable. */
const FAILED_POLLS_BEFORE_UNREACHABLE = 3;
/** After this many polls in a row to which the engine says it has no such task, the run is lost. */
const NOT_FOUND_POLLS_BEFORE_LOST = 3;
/** The most lines one answer of the log route holds. */
export const LOG_PAGE_LINES = 1000;
/** The lines a new listener of the events stream gets first. */
export const LOG_REPLAY_LINES = 500;

export type RunEvent = { type: "run"; run: RunView } | { type: "log"; lines: string[]; from: number };

/** What changes on a run: the saved fields, and the progress of the steps before the engine has the images, which is kept in memory only. */
export interface RunUpdate extends RunPatch {
  step?: RunView["step"];
  download?: RunView["download"];
  upload?: RunView["upload"];
}

export interface RunTrackerDeps {
  runs: RunStore;
  engines: EngineStore;
  dataFolder: string;
  intervalMs: number;
  log: (line: string) => void;
  clientFor?: (endpoint: EngineEndpoint) => TaskClient;
}

interface Live {
  step: RunView["step"];
  download: RunView["download"];
  upload: RunView["upload"];
}

/** What the tracker remembers about one run it follows. */
interface Following {
  failedPolls: number;
  notFoundPolls: number;
  unknownCodes: Set<string>;
  busy: boolean;
}

/** Follows the tasks of runs on their engines, saves what they report, and tells whoever listens. */
export class RunTracker {
  private readonly runs: RunStore;
  private readonly engines: EngineStore;
  private readonly dataFolder: string;
  private readonly intervalMs: number;
  private readonly logLine: (line: string) => void;
  private readonly clientFor: (endpoint: EngineEndpoint) => TaskClient;
  private readonly following = new Map<number, Following>();
  private readonly live = new Map<number, Live>();
  /** Lines saved per run, counted once from the file. It is also the next line to ask the engine for. */
  private readonly lineCounts = new Map<number, number>();
  /** Where in our log the output of the engine's latest restart begins, per run. Kept in a file next to the log. */
  private readonly restartLines = new Map<number, number | null>();
  private readonly listeners = new Map<number, Set<(event: RunEvent) => void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private stopped = false;

  constructor(deps: RunTrackerDeps) {
    this.runs = deps.runs;
    this.engines = deps.engines;
    this.dataFolder = deps.dataFolder;
    this.intervalMs = deps.intervalMs;
    this.logLine = deps.log;
    this.clientFor = deps.clientFor ?? ((endpoint) => new TaskClient(endpoint, { log: deps.log }));
  }

  /**
   * Picks up every run whose task is on an engine and not finished, so a run
   * goes on being followed after aidm-ui restarts. A run that was still being
   * prepared here (downloading or uploading) died with the old process.
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const run of this.runs.listUnfinished()) {
      if (run.state === "created" || run.state === "uploading") this.abandon(run);
      else this.follow(run.id);
    }
    this.timer = setInterval(() => {
      for (const runId of [...this.following.keys()]) void this.pollOnce(runId);
    }, this.intervalMs);
  }

  /** Stops polling. A poll still on its way is dropped when it ends, so nothing is saved after this returns. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.following.clear();
    this.listeners.clear();
  }

  /** Starts polling this run's task, at once and then every interval. */
  follow(runId: number): void {
    if (this.stopped || this.following.has(runId)) return;
    const run = this.runs.get(runId);
    if (run === null || run.taskUuid === null || isFinished(run.state)) return;
    this.following.set(runId, {
      failedPolls: 0,
      notFoundPolls: 0,
      unknownCodes: new Set(),
      busy: false,
    });
    if (this.started) void this.pollOnce(runId);
  }

  view(runId: number): RunView | null {
    const run = this.runs.get(runId);
    return run === null ? null : this.viewOf(run);
  }

  /** The saved console lines from line number `from` on, at most one page. `next` is where the next page starts. */
  log(runId: number, from: number): RunLogView {
    const start = Math.max(0, Math.min(from, this.lineCount(runId)));
    const lines = this.readLines(runId, start, LOG_PAGE_LINES);
    return { lines, next: start + lines.length, restartedAtLine: this.restartLine(runId) };
  }

  /** The newest saved lines, and the line number of the first one. What a listener gets when it joins. */
  recentLog(runId: number): { lines: string[]; from: number } {
    const from = Math.max(0, this.lineCount(runId) - LOG_REPLAY_LINES);
    return { lines: this.readLines(runId, from, LOG_REPLAY_LINES), from };
  }

  subscribe(runId: number, listener: (event: RunEvent) => void): () => void {
    let set = this.listeners.get(runId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      this.listeners.get(runId)?.delete(listener);
    };
  }

  /**
   * Saves what changed on a run and tells its listeners. A finished run is no
   * longer followed, and it never changes again: an update to it is dropped.
   */
  update(runId: number, patch: RunUpdate): void {
    if (this.stopped) return;
    const existing = this.runs.get(runId);
    if (existing !== null && isFinished(existing.state)) return;
    const { step, download, upload, ...saved } = patch;
    const live = this.liveOf(runId);
    if (step !== undefined) live.step = step;
    if (download !== undefined) live.download = download;
    if (upload !== undefined) live.upload = upload;

    const record = Object.keys(saved).length > 0 ? this.runs.update(runId, saved) : this.runs.get(runId);
    if (record === null) return;
    if (isFinished(record.state)) {
      this.following.delete(runId);
      live.step = null;
      live.download = null;
      live.upload = null;
    }
    this.emit(runId, { type: "run", run: this.viewOf(record) });
  }

  /** The engine's results archive for a completed run. */
  async openResults(runId: number): Promise<TaskApiResult<Response> | null> {
    const run = this.runs.get(runId);
    if (run === null || run.state !== "completed" || run.taskUuid === null || run.engineId === null) return null;
    const engine = this.engines.get(run.engineId);
    if (engine === null) return null;
    return this.clientFor({ address: engine.address, token: engine.token }).downloadResults(run.taskUuid);
  }

  private liveOf(runId: number): Live {
    let live = this.live.get(runId);
    if (live === undefined) {
      live = { step: null, download: null, upload: null };
      this.live.set(runId, live);
    }
    return live;
  }

  private viewOf(run: RunRecord): RunView {
    const live = this.live.get(run.id);
    return {
      id: run.id,
      projectId: run.projectId,
      engineId: run.engineId,
      engineName: run.engineId === null ? null : (this.engines.get(run.engineId)?.name ?? null),
      engineLocal: run.engineId !== null && this.engines.get(run.engineId)?.kind === "local",
      state: run.state,
      step: live?.step ?? null,
      download: live?.download ?? null,
      upload: live?.upload ?? null,
      progress: run.progress,
      engineMessage: run.engineMessage,
      problem: run.problem,
      restarted: run.restarted,
      resultsAvailable: run.state === "completed" && run.taskUuid !== null,
      createdAt: run.createdAt,
    };
  }

  private emit(runId: number, event: RunEvent): void {
    for (const listener of [...(this.listeners.get(runId) ?? [])]) {
      try {
        listener(event);
      } catch (error) {
        this.logLine(`A run listener failed: ${describe(error)}`);
      }
    }
  }

  private logPath(runId: number): string {
    return join(this.dataFolder, "runs", String(runId), "log.txt");
  }

  private restartPath(runId: number): string {
    return join(this.dataFolder, "runs", String(runId), "restarted-at-line.txt");
  }

  /** The line of our log where the engine's latest output begins after a restart, or null. */
  private restartLine(runId: number): number | null {
    let line = this.restartLines.get(runId);
    if (line === undefined) {
      const path = this.restartPath(runId);
      const value = existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : Number.NaN;
      line = Number.isInteger(value) && value >= 0 ? value : null;
      this.restartLines.set(runId, line);
    }
    return line;
  }

  /** The engine started the task over, so its output begins again from its line 0, at the end of what we hold. */
  private markRestart(runId: number): void {
    const line = this.lineCount(runId);
    mkdirSync(join(this.dataFolder, "runs", String(runId)), { recursive: true });
    writeFileSync(this.restartPath(runId), String(line));
    this.restartLines.set(runId, line);
  }

  /** The next line to ask the engine for: it counts its own lines, from its latest start. */
  private engineLine(runId: number): number {
    return this.lineCount(runId) - (this.restartLine(runId) ?? 0);
  }

  /** How many lines the run has saved. The file is read for this only the first time. */
  private lineCount(runId: number): number {
    let count = this.lineCounts.get(runId);
    if (count === undefined) {
      count = countLines(this.readFile(runId));
      this.lineCounts.set(runId, count);
    }
    return count;
  }

  private readFile(runId: number): string {
    const path = this.logPath(runId);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  /** At most `max` lines, starting at line number `start`. */
  private readLines(runId: number, start: number, max: number): string[] {
    const text = this.readFile(runId);
    let at = 0;
    for (let skipped = 0; skipped < start; skipped++) {
      const end = text.indexOf("\n", at);
      if (end === -1) return [];
      at = end + 1;
    }
    const lines: string[] = [];
    while (lines.length < max && at < text.length) {
      const end = text.indexOf("\n", at);
      if (end === -1) {
        lines.push(text.slice(at));
        break;
      }
      lines.push(text.slice(at, end));
      at = end + 1;
    }
    return lines;
  }

  private saveLines(runId: number, lines: string[]): void {
    const before = this.lineCount(runId);
    const path = this.logPath(runId);
    mkdirSync(join(this.dataFolder, "runs", String(runId)), { recursive: true });
    // One engine line is one file line, so the line count is also the engine's next line number.
    appendFileSync(path, lines.map((line) => `${line.replace(/[\r\n]+/g, " ")}\n`).join(""));
    this.lineCounts.set(runId, before + lines.length);
  }

  /** A run that was being prepared when aidm-ui stopped cannot go on. */
  private abandon(run: RunRecord): void {
    this.update(run.id, { state: "failed", problem: { code: "run.interrupted", data: {} } });
    const engine = run.engineId === null ? null : this.engines.get(run.engineId);
    if (run.taskUuid !== null && engine !== null) {
      const uuid = run.taskUuid;
      const failed = () => this.logLine(`Run ${run.id}: the engine task could not be removed after the restart.`);
      void this.clientFor({ address: engine.address, token: engine.token })
        .removeTask(uuid)
        .then((removed) => {
          if (!removed.ok) failed();
        }, failed);
    }
  }

  /** One poll at a time per run. Never rejects: a failed poll is a log line and the next one tries again. */
  private async pollOnce(runId: number): Promise<void> {
    const following = this.following.get(runId);
    if (following === undefined || following.busy || this.stopped) return;
    following.busy = true;
    try {
      await this.poll(runId, following);
    } catch (error) {
      this.logLine(`Polling run ${runId} failed: ${describe(error)}`);
    } finally {
      following.busy = false;
    }
  }

  /** True while this poll is still the one that counts. */
  private current(runId: number, following: Following): RunRecord | null {
    if (this.stopped || this.following.get(runId) !== following) return null;
    const run = this.runs.get(runId);
    return run === null || isFinished(run.state) ? null : run;
  }

  private async poll(runId: number, following: Following): Promise<void> {
    const run = this.current(runId, following);
    if (run === null || run.taskUuid === null) {
      this.following.delete(runId);
      return;
    }
    const engine = run.engineId === null ? null : this.engines.get(run.engineId);
    if (engine === null) {
      this.pollFailed(runId, following);
      return;
    }
    const client = this.clientFor({ address: engine.address, token: engine.token });
    const info = await client.taskInfo(run.taskUuid);
    if (!info.ok) {
      if (this.current(runId, following) !== null) this.pollFailed(runId, following, info.failure);
      return;
    }
    const state = runStateFromTask(info.value.statusCode, info.value.processingTime);
    // A task that was processing and is queued again was started over by the engine, and its log starts again too.
    const restarted = run.state === "processing" && state === "queued";
    if (restarted) this.markRestart(runId);
    // The output comes before the state, so a finished run's last lines are saved before the run shows as finished.
    const output = await client.taskOutput(run.taskUuid, this.engineLine(runId));
    const before = this.current(runId, following);
    if (before === null) return;
    if (!output.ok) {
      this.pollFailed(runId, following, output.failure);
      return;
    }

    following.failedPolls = 0;
    following.notFoundPolls = 0;
    if (output.value.length > 0) {
      const from = this.lineCount(runId);
      this.saveLines(runId, output.value);
      this.emit(runId, { type: "log", lines: output.value, from });
    }

    if (state === "unknown") {
      const raw = JSON.stringify(info.value.statusCode) ?? String(info.value.statusCode);
      if (!following.unknownCodes.has(raw)) {
        following.unknownCodes.add(raw);
        this.logLine(`Run ${runId}: the engine sent an unknown status code: ${raw}`);
      }
    }
    const progress = info.value.progress;
    const message = info.value.errorMessage;
    if (restarted || before.state !== state || before.progress !== progress || before.engineMessage !== message) {
      this.update(runId, { state, progress, engineMessage: message, ...(restarted ? { restarted: true } : {}) });
    }
  }

  /** One poll got no usable answer. A task the engine does not know ends the run; anything else is counted as unreachable. */
  private pollFailed(runId: number, following: Following, failure?: TaskApiFailure): void {
    if (failure !== undefined && isTaskNotFound(failure)) {
      // The engine answered, so it is reachable; it just does not have the task.
      following.failedPolls = 0;
      following.notFoundPolls++;
      if (following.notFoundPolls >= NOT_FOUND_POLLS_BEFORE_LOST) {
        this.logLine(`Run ${runId}: the engine no longer knows the task.`);
        this.update(runId, { state: "failed", problem: { code: "run.engine_lost", data: {} } });
      }
      return;
    }
    following.notFoundPolls = 0;
    following.failedPolls++;
    if (following.failedPolls < FAILED_POLLS_BEFORE_UNREACHABLE) return;
    const run = this.runs.get(runId);
    if (run !== null && run.state !== "engine_unreachable") {
      this.logLine(`Run ${runId}: the engine has not answered ${following.failedPolls} times in a row.`);
      this.update(runId, { state: "engine_unreachable" });
    }
  }
}

/** Lines in a log file's text: every line ends with a newline, and a last one that does not still counts. */
function countLines(text: string): number {
  if (text === "") return 0;
  let count = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count++;
  return text.endsWith("\n") ? count : count + 1;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
