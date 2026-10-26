import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunLogView, RunView } from "../../shared/api-types.ts";
import type { EngineStore } from "../engines/engine-store.ts";
import { TaskClient, type EngineEndpoint, type TaskApiResult } from "../task-api/task-client.ts";
import { isFinished, runStateFromTask } from "./run-state.ts";
import type { RunPatch, RunRecord, RunStore } from "./run-store.ts";

export const DEFAULT_RUN_POLL_INTERVAL_MS = 2000;
/** After this many polls in a row without an answer the run shows the engine as unreachable. */
const FAILED_POLLS_BEFORE_UNREACHABLE = 3;

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
  /** Lines of the engine's output already saved, which is also the line to ask for next. */
  lines: number;
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
      lines: this.savedLines(runId).length,
      unknownCodes: new Set(),
      busy: false,
    });
    if (this.started) void this.pollOnce(runId);
  }

  view(runId: number): RunView | null {
    const run = this.runs.get(runId);
    return run === null ? null : this.viewOf(run);
  }

  /** The saved console lines from line number `from` on. */
  log(runId: number, from: number): RunLogView {
    const lines = this.savedLines(runId);
    const start = Math.max(0, Math.min(from, lines.length));
    return { lines: lines.slice(start), next: lines.length };
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

  /** Saves what changed on a run and tells its listeners. A finished run is no longer followed. */
  update(runId: number, patch: RunUpdate): void {
    if (this.stopped) return;
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

  private savedLines(runId: number): string[] {
    const path = this.logPath(runId);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    return text === "" ? [] : text.replace(/\n$/, "").split("\n");
  }

  private saveLines(runId: number, lines: string[]): void {
    const path = this.logPath(runId);
    mkdirSync(join(this.dataFolder, "runs", String(runId)), { recursive: true });
    // One engine line is one file line, so the line count is also the engine's next line number.
    appendFileSync(path, lines.map((line) => `${line.replace(/[\r\n]+/g, " ")}\n`).join(""));
  }

  /** A run that was being prepared when aidm-ui stopped cannot go on. */
  private abandon(run: RunRecord): void {
    this.update(run.id, {
      state: "failed",
      problem:
        run.state === "created"
          ? { code: "download.cancelled", data: { interrupted: true } }
          : { code: "run.upload_failed", data: { interrupted: true } },
    });
    const engine = run.engineId === null ? null : this.engines.get(run.engineId);
    if (run.taskUuid !== null && engine !== null) {
      const uuid = run.taskUuid;
      void this.clientFor({ address: engine.address, token: engine.token })
        .removeTask(uuid)
        .catch(() => {});
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
      if (this.current(runId, following) !== null) this.pollFailed(runId, following);
      return;
    }
    // The output comes before the state, so a finished run's last lines are saved before the run shows as finished.
    const output = await client.taskOutput(run.taskUuid, following.lines);
    const before = this.current(runId, following);
    if (before === null) return;
    if (!output.ok) {
      this.pollFailed(runId, following);
      return;
    }

    following.failedPolls = 0;
    if (output.value.length > 0) {
      const from = following.lines;
      this.saveLines(runId, output.value);
      following.lines += output.value.length;
      this.emit(runId, { type: "log", lines: output.value, from });
    }

    const state = runStateFromTask(info.value.statusCode, info.value.processingTime);
    if (state === "unknown") {
      const raw = JSON.stringify(info.value.statusCode) ?? String(info.value.statusCode);
      if (!following.unknownCodes.has(raw)) {
        following.unknownCodes.add(raw);
        this.logLine(`Run ${runId}: the engine sent an unknown status code: ${raw}`);
      }
    }
    const progress = info.value.progress;
    const message = info.value.errorMessage;
    if (before.state !== state || before.progress !== progress || before.engineMessage !== message) {
      this.update(runId, { state, progress, engineMessage: message });
    }
  }

  private pollFailed(runId: number, following: Following): void {
    following.failedPolls++;
    if (following.failedPolls < FAILED_POLLS_BEFORE_UNREACHABLE) return;
    const run = this.runs.get(runId);
    if (run !== null && run.state !== "engine_unreachable") {
      this.logLine(`Run ${runId}: the engine has not answered ${following.failedPolls} times in a row.`);
      this.update(runId, { state: "engine_unreachable" });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
