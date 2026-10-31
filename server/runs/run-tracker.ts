import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lstat, realpath, rm } from "node:fs/promises";
import type { RunLogView, RunView } from "../../shared/api-types.ts";
import type { EngineRecord, EngineStore } from "../engines/engine-store.ts";
import type { UnreachableLines } from "../task-api/unreachable-lines.ts";
import { readLogJson, stageStarted, summaryFromOutput, summaryLine } from "./run-summary.ts";
import { isTaskNotFound, TaskClient, type EngineEndpoint, type TaskApiFailure } from "../task-api/task-client.ts";
import { isFinished, runStateFromTask } from "./run-state.ts";
import { ResultArchives } from "../results/result-archives.ts";
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
  queueCount?: number | null;
  step?: RunView["step"];
  download?: RunView["download"];
  upload?: RunView["upload"];
}

export interface RunTrackerDeps {
  beginResultsWrite?: (projectId: number) => (() => void) | null;
  runs: RunStore;
  engines: EngineStore;
  dataFolder: string;
  intervalMs: number;
  log: (line: string) => void;
  clientFor?: (endpoint: EngineEndpoint) => TaskClient;
  /** The "Could not reach" lines, shared with the other clients of each engine. */
  unreachable?: UnreachableLines;
  /** Where a task of this engine keeps its files, when aidm-ui can read them there: the local engine's task folder. */
  taskFolder?: (engine: EngineRecord, taskUuid: string) => string | null;
}

interface Live {
  queueCount: number | null;
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
  /** True from the moment the task was seen processing until it is seen in any other state. Survives polls that got no answer. */
  wasProcessing: boolean;
  /** The task's processing time when it was last seen processing, to notice it going back. */
  processingTime: number | null;
  /** The engine's own time for the task at the last answer, in milliseconds, for the summary. */
  engineMs: number | null;
  /** The stages the task output started, with when aidm-ui first saw each, for the summary of a remote engine's run. */
  stageSeen: Array<{ name: string; at: number }>;
}

/** Follows the tasks of runs on their engines, saves what they report, and tells whoever listens. */
export class RunTracker {
  recoverMissing: ((id: number) => Promise<boolean>) | undefined;
  readonly results: ResultArchives;
  private readonly runs: RunStore;
  private readonly engines: EngineStore;
  private readonly dataFolder: string;
  private readonly intervalMs: number;
  private readonly logLine: (line: string) => void;
  private readonly clientFor: (endpoint: EngineEndpoint) => TaskClient;
  private readonly following = new Map<number, Following>();
  private readonly taskFolder: (engine: EngineRecord, taskUuid: string) => string | null;
  private readonly live = new Map<number, Live>();
  /** Lines saved per run, counted once from the file. It is also the next line to ask the engine for. */
  private readonly lineCounts = new Map<number, number>();
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
    this.clientFor = deps.clientFor ?? ((endpoint) => new TaskClient(endpoint, { log: deps.log, unreachable: deps.unreachable }));
    this.taskFolder = deps.taskFolder ?? (() => null);
    this.results = new ResultArchives({ runs: deps.runs, folder: deps.dataFolder, log: deps.log,
      beginWrite: deps.beginResultsWrite ?? (() => () => {}),
      changed: id => { const view = this.view(id); if (!this.stopped && view) this.emit(id, { type: "run", run: view }); },
      request: run => async (headers, signal) => {
        const engine = run.engineId === null ? null : this.engines.get(run.engineId);
        if (engine === null || run.taskUuid === null) throw new Error("Results engine is unavailable");
        const result = await this.clientFor({ address: engine.address, token: engine.token }).downloadResults(run.taskUuid, { headers, signal });
        if (!result.ok) throw new Error("Results download failed");
        return result.value;
      },
    });
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
      if ((run.state === "created" || run.state === "uploading") && !run.restartPending) this.abandon(run);
      else this.follow(run.id);
    }
    for (const run of this.runs.completed()) this.results.ensure(run);
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
    await this.results.stop();
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
      wasProcessing: run.state === "processing",
      processingTime: null,
      engineMs: null,
      stageSeen: [],
    });
    if (this.started) void this.pollOnce(runId);
  }

  record(runId: number): RunRecord | null { return this.runs.get(runId); }

  pause(runId: number): void { this.following.delete(runId); }

  async remove(run: RunRecord): Promise<void> {
    this.pause(run.id);
    for (const [root, path] of [
      [join(this.dataFolder, "runs"), join(this.dataFolder, "runs", String(run.id))],
      [join(this.dataFolder, "projects", String(run.projectId), "runs"), join(this.dataFolder, "projects", String(run.projectId), "runs", String(run.id))],
    ]) {
      try {
        const info = await lstat(root!);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root!) !== resolve(root!)) throw new Error("Invalid run folder");
        await rm(path!, { recursive: true, force: true });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.runs.remove(run.id);
    this.live.delete(run.id); this.lineCounts.delete(run.id); this.listeners.delete(run.id);
  }

  view(runId: number): RunView | null {
    const run = this.runs.get(runId);
    return run === null ? null : this.viewOf(run);
  }

  /** The saved console lines from line number `from` on, at most one page. `next` is where the next page starts. */
  log(runId: number, from: number): RunLogView {
    const start = Math.max(0, Math.min(from, this.lineCount(runId)));
    const lines = this.readLines(runId, start, LOG_PAGE_LINES);
    return { lines, next: start + lines.length, restartedAtLine: this.runs.get(runId)?.restartedAtLine ?? null };
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
    const { step, download, upload, queueCount, ...saved } = patch;
    const live = this.liveOf(runId);
    if (queueCount !== undefined) live.queueCount = queueCount;
    if (step !== undefined) live.step = step;
    if (download !== undefined) live.download = download;
    if (upload !== undefined) live.upload = upload;

    const record = Object.keys(saved).length > 0 ? this.runs.update(runId, saved) : this.runs.get(runId);
    if (record === null) return;
    if (isFinished(record.state)) {
      this.summarise(record, this.following.get(runId));
      this.following.delete(runId);
      live.step = null;
      live.download = null;
      live.upload = null;
    }
    if (record.state === "completed") this.results.ensure(record);
    this.emit(runId, { type: "run", run: this.viewOf(record) });
  }

  private liveOf(runId: number): Live {
    let live = this.live.get(runId);
    if (live === undefined) {
      live = { step: null, download: null, upload: null, queueCount: null };
      this.live.set(runId, live);
    }
    return live;
  }

  private viewOf(run: RunRecord): RunView {
    const live = this.live.get(run.id);
    const results = this.results.view(run.id);
    return {
      ...(run.state === "queued" ? { queueCount: live?.queueCount ?? null } : {}),
      id: run.id,
      projectId: run.projectId,
      name: run.name,
      preset: run.preset,
      ...(run.presetName !== undefined ? { presetName: run.presetName } : {}),
      wayIn: run.wayIn,
      sample: run.sample,
      engineId: run.engineId,
      engineName: run.engineId === null ? null : (this.engines.get(run.engineId)?.name ?? null),
      engineLocal: run.engineId !== null && this.engines.get(run.engineId)?.kind === "local",
      state: run.state,
      step: results?.state === "fetching" ? "results" : live?.step ?? null,
      download: live?.download ?? null,
      upload: live?.upload ?? null,
      progress: run.progress,
      engineMessage: run.engineMessage,
      problem: run.problem,
      restarted: run.restarted,
      restartedAtLine: run.restartedAtLine,
      resultsAvailable: results?.state === "ready",
      ...(results ? { results } : {}),
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

  /**
   * One line in the diagnosis log for a run that just ended, with the engine's
   * figures (run-summary.ts). It must never stop the run from ending, so a failure
   * here is only a line of its own.
   */
  private summarise(run: RunRecord, following: Following | undefined): void {
    try {
      const engine = run.engineId === null ? null : this.engines.get(run.engineId);
      const folder = engine === null || run.taskUuid === null ? null : this.taskFolder(engine, run.taskUuid);
      let summary = readLogJson(folder);
      if (summary === null) {
        const path = this.logPath(run.id);
        const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
        summary = summaryFromOutput(lines, following?.stageSeen ?? [], Date.now(), following?.engineMs ?? null);
      } else if (summary.engineSeconds === null && following?.engineMs != null) {
        summary = { ...summary, engineSeconds: Math.round(following.engineMs / 100) / 10 };
      }
      const where =
        folder !== null
          ? `${join(folder, "task_output.txt")} and log.json next to it`
          : run.taskUuid === null
            ? "none, the task never reached the engine"
            : `on the engine, in the folder of task ${run.taskUuid} (task_output.txt and log.json, also in its all.zip); AIDM UI's copy of the output is ${this.logPath(run.id)}`;
      this.logLine(summaryLine({ id: run.id, state: run.state, engineName: engine?.kind === "local" ? "this computer" : (engine?.name ?? "?") }, summary, where));
    } catch (error) {
      this.logLine(`Run ${run.id}: the summary could not be made: ${describe(error)}`);
    }
  }

  private logPath(runId: number): string {
    return join(this.dataFolder, "runs", String(runId), "log.txt");
  }

  /** The engine started the task over, so its output begins again from its line 0, at the end of what we hold. */
  private markRestart(runId: number): void {
    this.update(runId, { restarted: true, restartedAtLine: this.lineCount(runId) });
  }

  /** How many lines of the engine's latest start we hold. The engine counts its own lines from that start. */
  private heldLines(runId: number): number {
    return this.lineCount(runId) - (this.runs.get(runId)?.restartedAtLine ?? 0);
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
    if (run.taskUuid !== null && engine !== null && !run.taskRetired) {
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
      if (this.current(runId, following) !== null) await this.pollFailed(runId, following, info.failure);
      return;
    }
    if (this.current(runId, following) === null) return;
    const state = runStateFromTask(info.value.statusCode, info.value.processingTime);
    if (run.restartPending) {
      if (isFinished(state)) {
        this.update(runId, { state: "failed", restartPending: false, problem: { code: "run.restart_unconfirmed", data: {} } });
        return;
      }
      if (state === "queued" || state === "processing") this.update(runId, { restartPending: false });
    }
    const queue = state === "queued" ? await client.info() : null;
    const processingTime = info.value.processingTime;
    if (processingTime !== null && processingTime >= 0) following.engineMs = processingTime;
    // The engine started the task over, and its log starts again too. The run's own state cannot tell:
    // polls that got no answer may have turned it into engine_unreachable in between.
    // A processing time that went down is a restart. Queued again after processing is only a hint,
    // since the memory of "processing" may be stale (from before a restart of aidm-ui): it counts
    // only when the engine's output is shorter than the lines of its latest start that we hold.
    const queuedAgain = state === "queued" && following.wasProcessing;
    const timeWentBack =
      state === "processing" && processingTime !== null && following.processingTime !== null && processingTime < following.processingTime;
    if (timeWentBack) this.markRestart(runId);
    if (state !== "unknown") {
      following.wasProcessing = state === "processing";
      following.processingTime = state === "processing" ? processingTime : null;
    }

    // The output comes before the state, so a finished run's last lines are saved before the run shows as finished.
    // One line already held is asked for again (all of them when a restart is suspected): an engine that answers
    // with fewer lines than we got started over without us seeing it.
    let held = this.heldLines(runId);
    let output = await client.taskOutput(run.taskUuid, queuedAgain ? 0 : Math.max(0, held - 1));
    const shorter = output.ok && held > 0 && (queuedAgain ? output.value.length < held : output.value.length === 0);
    if (shorter) {
      this.markRestart(runId);
      following.wasProcessing = false;
      following.processingTime = null;
      held = 0;
      if (!queuedAgain) output = await client.taskOutput(run.taskUuid, 0);
    } else if (queuedAgain && held === 0) {
      // Nothing of the new start was held yet, so where its output begins does not move.
      this.markRestart(runId);
    }
    if (queuedAgain && !shorter && output.ok && held > 0) {
      // The whole output was asked for; keep only what follows the last line held, as on any other poll.
      output = { ok: true, value: output.value.slice(held - 1) };
    }
    const before = this.current(runId, following);
    if (before === null) return;
    if (!output.ok) {
      await this.pollFailed(runId, following, output.failure);
      return;
    }
    const newLines = held > 0 ? output.value.slice(1) : output.value;

    following.failedPolls = 0;
    following.notFoundPolls = 0;
    if (newLines.length > 0) {
      const at = Date.now();
      for (const line of newLines) {
        const stage = stageStarted(line);
        if (stage !== null && !following.stageSeen.some((seen) => seen.name === stage)) following.stageSeen.push({ name: stage, at });
      }
      const from = this.lineCount(runId);
      this.saveLines(runId, newLines);
      this.emit(runId, { type: "log", lines: newLines, from });
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
    const queueCount = queue?.ok ? queue.value.queueCount : null;
    if (before.state !== state || before.progress !== progress || before.engineMessage !== message || this.live.get(runId)?.queueCount !== queueCount) {
      this.update(runId, { state, progress, engineMessage: message, queueCount });
    }
  }

  /** One poll got no usable answer. A task the engine does not know ends the run; anything else is counted as unreachable. */
  private async pollFailed(runId: number, following: Following, failure?: TaskApiFailure): Promise<void> {
    const uuid = this.runs.get(runId)?.taskUuid;
    if (failure !== undefined && uuid && isTaskNotFound(failure, uuid)) {
      // The engine answered, so it is reachable; it just does not have the task.
      following.failedPolls = 0;
      following.notFoundPolls++;
      if (following.notFoundPolls >= NOT_FOUND_POLLS_BEFORE_LOST) {
        if (this.recoverMissing && await this.recoverMissing(runId)) return;
        if (this.current(runId, following) === null) return;
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
