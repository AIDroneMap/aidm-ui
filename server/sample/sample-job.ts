import { join, basename } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { EngineView, ReferenceTimeView, RunView, SampleEngineOffer, SampleView } from "../../shared/api-types.ts";
import { downloadVerified } from "../downloads/downloader.ts";
import type { EngineMonitor } from "../engines/engine-monitor.ts";
import type { EngineStore } from "../engines/engine-store.ts";
import { freeBytes as defaultFreeBytes, type FreeBytes } from "../machine/disk.ts";
import { SAMPLE_JOB_PEAK_MEMORY } from "../machine/thresholds.ts";
import { isFinished } from "../runs/run-state.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { RunTracker } from "../runs/run-tracker.ts";
import { TaskClient, type EngineEndpoint, type TaskApiFailure } from "../task-api/task-client.ts";
import type { SampleDatasetEntry } from "./sample-dataset.ts";
import { readStoredZip, type ZipEntry } from "./stored-zip.ts";

export type SampleOutcome =
  | { ok: true; run: RunView }
  | { ok: false; status: number; error: ApiError };

export interface SampleJobDeps {
  dataset: SampleDatasetEntry;
  dataFolder: string;
  runs: RunStore;
  tracker: RunTracker;
  engines: EngineMonitor;
  engineStore: EngineStore;
  /** process.arch of this computer, for choosing the measured reference time. */
  architecture: string;
  log: (line: string) => void;
  fetch?: typeof fetch;
  freeBytes?: FreeBytes;
  clientFor?: (endpoint: EngineEndpoint) => TaskClient;
}

/** How often the page hears about download and upload progress. */
const PROGRESS_INTERVAL_MS = 150;
const SAMPLE_PROJECT = "sample";

/**
 * The memory cap of an engine: what the sample job may count on. For now it is
 * the total memory the engine reports. The ticket that sets a cap on the
 * local engine changes this one function.
 */
export function engineMemoryCap(engine: EngineView): number | null {
  return engine.info?.totalMemory ?? null;
}

/** One sample run that is being prepared here: downloading, then uploading. */
interface Preparing {
  abort: AbortController;
  done: Promise<void>;
}

function referenceFor(dataset: SampleDatasetEntry, architecture: string): ReferenceTimeView | null {
  const entry = dataset.referenceTimes.find((candidate) => candidate.architecture === architecture);
  if (entry === undefined) return null;
  return {
    architecture: entry.architecture === "x64" ? "x86-64" : "arm64",
    seconds: entry.seconds,
    cores: entry.cores,
    memoryGiB: entry.memoryGiB,
  };
}

function problemForFailure(failure: TaskApiFailure): ApiError {
  return failure.kind === "engine_error"
    ? { code: "run.engine_refused", data: { message: failure.message } }
    : { code: "run.upload_failed", data: {} };
}

/** The sample job: download the pinned dataset, send its images to an engine, and hand the run to the tracker. */
export class SampleJob {
  private readonly preparing = new Map<number, Preparing>();
  private readonly clientFor: (endpoint: EngineEndpoint) => TaskClient;
  private readonly freeBytes: FreeBytes;

  constructor(private readonly deps: SampleJobDeps) {
    this.clientFor = deps.clientFor ?? ((endpoint) => new TaskClient(endpoint, { log: deps.log }));
    this.freeBytes = deps.freeBytes ?? defaultFreeBytes;
  }

  view(): SampleView {
    const { dataset } = this.deps;
    const projectId = this.projectId();
    const latest = projectId === null ? null : this.deps.runs.latestForProject(projectId);
    return {
      dataset: {
        name: dataset.name,
        licence: dataset.licence,
        licenceUrl: dataset.licenceUrl,
        attribution: dataset.attribution,
        imageCount: dataset.imageCount,
        size: dataset.size,
      },
      reference: referenceFor(dataset, this.deps.architecture),
      peakMemory: SAMPLE_JOB_PEAK_MEMORY,
      engines: this.deps.engines.views().map((engine) => this.offerFor(engine)),
      run: latest === null ? null : this.deps.tracker.view(latest.id),
    };
  }

  async start(engineId: number): Promise<SampleOutcome> {
    const offer = this.view().engines.find((candidate) => candidate.engineId === engineId);
    if (offer === undefined) return { ok: false, status: 404, error: { code: "engine.not_found", data: {} } };
    if (!offer.offered) {
      return { ok: false, status: 409, error: offer.reason ?? { code: "sample.engine_not_usable", data: {} } };
    }
    const projectId = this.projectId();
    if (projectId === null) throw new Error("The built-in sample project is missing.");
    const latest = this.deps.runs.latestForProject(projectId);
    if (latest !== null && !isFinished(latest.state)) {
      return { ok: false, status: 409, error: { code: "sample.already_running", data: {} } };
    }

    const run = this.deps.runs.create({ projectId, engineId, options: this.deps.dataset.options });
    const abort = new AbortController();
    this.deps.tracker.update(run.id, {
      step: "download",
      download: { received: 0, total: this.deps.dataset.size },
    });
    const done = this.prepare(run.id, engineId, abort.signal).catch((error: unknown) => {
      this.deps.log(`Run ${run.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      this.finish(run.id, { state: "failed", problem: { code: "run.upload_failed", data: {} } });
    });
    this.preparing.set(run.id, { abort, done });
    void done.finally(() => this.preparing.delete(run.id));
    return { ok: true, run: this.deps.tracker.view(run.id) as RunView };
  }

  async cancel(runId: number): Promise<SampleOutcome> {
    const run = this.deps.runs.get(runId);
    if (run === null) return { ok: false, status: 404, error: { code: "run.not_found", data: {} } };
    if (isFinished(run.state)) return { ok: false, status: 409, error: { code: "run.not_cancellable", data: {} } };

    const preparing = this.preparing.get(runId);
    if (preparing !== undefined) {
      // The work stops at its next step and ends the run itself, so only one place decides how it ends.
      preparing.abort.abort();
      await preparing.done;
      return { ok: true, run: this.deps.tracker.view(runId) as RunView };
    }

    const engine = run.engineId === null ? null : this.deps.engineStore.get(run.engineId);
    if (run.taskUuid !== null && engine !== null) {
      const result = await this.clientFor({ address: engine.address, token: engine.token }).cancelTask(run.taskUuid);
      // An engine that no longer knows the task has nothing to stop.
      const gone = !result.ok && result.failure.kind === "engine_error" && result.failure.message.endsWith("not found");
      if (!result.ok && !gone) {
        const failure = result.failure;
        return {
          ok: false,
          status: 502,
          error:
            failure.kind === "engine_error"
              ? { code: "engine.error", data: { message: failure.message } }
              : { code: failure.kind === "unreachable" ? "engine.unreachable" : "engine.bad_response", data: {} },
        };
      }
    }
    this.finish(runId, { state: "cancelled", problem: null });
    return { ok: true, run: this.deps.tracker.view(runId) as RunView };
  }

  /** Stops the work in progress and waits until it has ended, so nothing touches the database afterwards. */
  async stop(): Promise<void> {
    const all = [...this.preparing.values()];
    for (const preparing of all) preparing.abort.abort();
    await Promise.all(all.map((preparing) => preparing.done));
  }

  private projectId(): number | null {
    return this.deps.runs.builtinProjectId(SAMPLE_PROJECT);
  }

  private offerFor(engine: EngineView): SampleEngineOffer {
    const memoryCap = engineMemoryCap(engine);
    const base = { engineId: engine.id, engineName: engine.name, memoryCap };
    if (!this.deps.engines.isUsable(engine.id)) {
      return { ...base, offered: false, reason: { code: "sample.engine_not_usable", data: {} } };
    }
    if (memoryCap === null) return { ...base, offered: false, reason: { code: "sample.memory_unknown", data: {} } };
    if (memoryCap <= SAMPLE_JOB_PEAK_MEMORY) {
      return {
        ...base,
        offered: false,
        reason: { code: "sample.memory_below_peak", data: { cap: memoryCap, peak: SAMPLE_JOB_PEAK_MEMORY } },
      };
    }
    return { ...base, offered: true, reason: null };
  }

  private finish(runId: number, end: { state: "failed" | "cancelled"; problem: ApiError | null }): void {
    this.deps.tracker.update(runId, end);
  }

  /** Download, check, upload and commit. Ends by handing the run to the tracker or by finishing it. */
  private async prepare(runId: number, engineId: number, signal: AbortSignal): Promise<void> {
    const { dataset, tracker } = this.deps;
    const zipPath = join(this.deps.dataFolder, "downloads", dataset.fileName);

    let lastShown = 0;
    const downloaded = await downloadVerified(
      { url: dataset.url, size: dataset.size, sha256: dataset.sha256, path: zipPath },
      {
        fetch: this.deps.fetch,
        signal,
        freeBytes: this.freeBytes,
        onProgress: (received, total) => {
          const now = Date.now();
          if (received < total && now - lastShown < PROGRESS_INTERVAL_MS) return;
          lastShown = now;
          tracker.update(runId, { download: { received, total } });
        },
      },
    );
    if (!downloaded.ok) {
      if (downloaded.error.code === "download.cancelled" || signal.aborted) {
        return this.finish(runId, { state: "cancelled", problem: null });
      }
      return this.finish(runId, { state: "failed", problem: downloaded.error });
    }
    if (signal.aborted) return this.finish(runId, { state: "cancelled", problem: null });

    let images: ZipEntry[];
    try {
      const entries = await readStoredZip(zipPath);
      images = entries.filter((entry) => /\.jpe?g$/i.test(entry.name));
    } catch (error) {
      this.deps.log(`Run ${runId}: the dataset file cannot be read: ${error instanceof Error ? error.message : String(error)}`);
      images = [];
    }
    if (images.length !== dataset.imageCount) {
      return this.finish(runId, {
        state: "failed",
        problem: { code: "sample.dataset_invalid", data: { expected: dataset.imageCount, found: images.length } },
      });
    }

    const engine = this.deps.engineStore.get(engineId);
    if (engine === null) return this.finish(runId, { state: "failed", problem: { code: "run.upload_failed", data: {} } });
    const client = this.clientFor({ address: engine.address, token: engine.token });

    const created = await client.createTask("Sample job", dataset.options);
    if (!created.ok) return this.finish(runId, { state: "failed", problem: problemForFailure(created.failure) });
    const { uuid } = created.value;
    tracker.update(runId, {
      taskUuid: uuid,
      state: "uploading",
      step: "upload",
      download: null,
      upload: { done: 0, total: images.length },
    });

    const stopTask = async (end: { state: "failed" | "cancelled"; problem: ApiError | null }) => {
      const removed = await client.removeTask(uuid);
      if (!removed.ok) this.deps.log(`Run ${runId}: the engine task could not be removed after the upload stopped.`);
      this.finish(runId, end);
    };

    let shown = 0;
    for (const [index, image] of images.entries()) {
      if (signal.aborted) return stopTask({ state: "cancelled", problem: null });
      const data = Bun.file(zipPath).slice(image.offset, image.offset + image.size);
      const sent = await client.uploadImage(uuid, basename(image.name), data, signal);
      if (signal.aborted) return stopTask({ state: "cancelled", problem: null });
      if (!sent.ok) return stopTask({ state: "failed", problem: problemForFailure(sent.failure) });
      const now = Date.now();
      if (index + 1 === images.length || now - shown >= PROGRESS_INTERVAL_MS) {
        shown = now;
        tracker.update(runId, { upload: { done: index + 1, total: images.length } });
      }
    }

    const committed = await client.commitTask(uuid);
    if (!committed.ok) return stopTask({ state: "failed", problem: problemForFailure(committed.failure) });
    if (signal.aborted) {
      // The engine has the task now, so it is cancelled rather than removed.
      await client.cancelTask(uuid);
      return this.finish(runId, { state: "cancelled", problem: null });
    }
    // No await between the commit and the hand-over, so a cancel arriving now finds a run the tracker follows.
    this.preparing.delete(runId);
    tracker.update(runId, { state: "queued", step: null, upload: null });
    tracker.follow(runId);
  }
}
