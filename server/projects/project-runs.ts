import type { LinkStore } from "./link-store.ts";
import { createHash } from "node:crypto";
import type { ApiError } from "../../shared/api-error.ts";
import type { RunView } from "../../shared/api-types.ts";
import { PRESET_IDS, type PresetId } from "../../shared/option-catalogue.ts";
import { planPreset, SERVER_OUTPUT_KEYS } from "../../shared/run-plan.ts";
import type { ProjectRunRequest, ReviewOption, RunReviewView } from "../../shared/run-review.ts";
import type { EngineStore } from "../engines/engine-store.ts";
import { MIN_TASK_API_VERSION } from "../../shared/api-types.ts";
import { isSupportedVersion } from "../engines/versions.ts";
import { problemFromFailure } from "../engines/problems.ts";
import { reconcileOptions } from "../options/reconcile.ts";
import { validateOptions } from "../options/validate.ts";
import type { PhotoStore } from "../photos/photo-store.ts";
import type { RunRecord, RunStore } from "../runs/run-store.ts";
import { isFinished } from "../runs/run-state.ts";
import type { RunTracker } from "../runs/run-tracker.ts";
import { isNativePackage, type Settings } from "../settings/settings.ts";
import { isTaskNotFound, TaskClient, type EngineEndpoint, type TaskOption } from "../task-api/task-client.ts";
import { ImportUnavailable } from "./import-store.ts";
import type { ProjectDeletion } from "./project-deletion.ts";
import type { ProjectStore } from "./project-store.ts";
import { RunInputs, RunInputsChanged, type RunInputSnapshot, type SavedRunInputs } from "./run-inputs.ts";

type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; error: ApiError };
function refuse(status: number, code: ApiError["code"], data: ApiError["data"] = {}): { ok: false; status: number; error: ApiError } {
  return { ok: false, status, error: { code, data } };
}
type ReviewedInputs = RunInputSnapshot | { wayIn: "link"; revision: string; url: string };
type SavedSource = SavedRunInputs | { wayIn: "link"; url: string; revision: string };
interface Reviewed { view: RunReviewView; inputs: ReviewedInputs; options: TaskOption[]; client: TaskClient }
interface Preparing { abort: AbortController; done: Promise<void>; cancelFailure: ApiError | null }
interface Dependencies {
  projects: ProjectStore;
  projectDeletion: ProjectDeletion;
  inputs: RunInputs;
  photos: PhotoStore;
  links: LinkStore;
  engines: EngineStore;
  runs: RunStore;
  tracker: RunTracker;
  settings: Settings;
  log: (line: string) => void;
  clientFor?: (endpoint: EngineEndpoint) => TaskClient;
}

/** Reviews the server's inputs and settings, then prepares one task from that snapshot. */
export class ProjectRuns {
  private readonly preparing = new Map<number, Preparing>();
  private readonly starting = new Set<string>();
  private readonly deleting = new Set<number>();
  private readonly sourcesInUse = new Map<number, number>();
  private readonly clientFor: (endpoint: EngineEndpoint) => TaskClient;
  constructor(private readonly deps: Dependencies) {
    this.clientFor = deps.clientFor ?? (endpoint => new TaskClient(endpoint, { log: deps.log }));
    deps.tracker.recoverMissing = id => this.recover(id);
  }

  private async inspect(id: number, engineId: number, preset: PresetId, offset: number, edits: Readonly<NonNullable<ProjectRunRequest["options"]>> = [], presetName?: string, sourceRunId?: number): Promise<Outcome<Reviewed>> {
    const { projects, engines, inputs, photos, settings } = this.deps;
    if (id === projects.sampleId()) return refuse(409, "project.sample_photos_forbidden");
    const project = projects.get(id);
    if (!project) return refuse(404, "project.not_found");
    if (project.builtin) return refuse(409, "project.sample_photos_forbidden");
    const engine = engines.get(engineId);
    if (!engine || !engine.enabled || !engine.address) return refuse(409, "project_run.engine_unavailable");
    const client = this.clientFor(engine);
    const [info, reported] = await Promise.all([client.info(), client.options()]);
    if (!info.ok) return { ok: false, status: 502, error: problemFromFailure(info.failure) };
    if (!isSupportedVersion(info.value.version)) return refuse(409, "engine.unsupported_version", { version: info.value.version, minimum: MIN_TASK_API_VERSION });
    if (!reported.ok) return { ok: false, status: 502, error: problemFromFailure(reported.failure) };
    const original = sourceRunId === undefined ? null : this.deps.runs.get(sourceRunId);
    if (sourceRunId !== undefined && (!original || original.projectId !== id)) return refuse(404, "run.not_found");
    if (original && (!isFinished(original.state) || original.sample)) return refuse(409, "run.action_unavailable");
    const source = original ? this.deps.runs.source<SavedSource>(original.id) : null;
    if (original && !source) return refuse(409, "run.photos_unavailable");
    let snapshot: ReviewedInputs;
    let facts;
    try {
      if (source) {
        snapshot = source.wayIn === "link" ? source : source.snapshot;
        facts = null;
      } else {
        if (this.deps.links.isBusy(id)) return refuse(409, "link.busy");
        const url = this.deps.links.get(id);
        if (url !== null) {
          facts = null;
          snapshot = { wayIn: "link", revision: this.deps.links.revision(id), url };
        } else {
          facts = await photos.facts(id, offset, 50);
          snapshot = await inputs.snapshot(id);
          if (this.deps.links.isBusy(id) || this.deps.links.has(id)) return refuse(409, "project_run.review_changed");
        }
      }
    } catch (error) {
      if (error instanceof ImportUnavailable || error instanceof RunInputsChanged) return refuse(409, "project_run.photos_changed");
      throw error;
    }
    const archiveUnavailable = original?.engineId === engineId && original.taskUuid !== null && this.deps.runs.taskRuns(engineId, original.taskUuid).some(run => this.hasUnsavedArchive(run));
    const previousTask = archiveUnavailable && original.taskUuid ? await client.taskInfo(original.taskUuid) : null;
    const previousTaskMissing = previousTask !== null && !previousTask.ok && isTaskNotFound(previousTask.failure, original!.taskUuid!);
    const currentEngine = engines.get(engineId);
    if (!currentEngine?.enabled) return refuse(409, "project_run.engine_unavailable");
    if (currentEngine.address !== engine.address || currentEngine.token !== engine.token) return refuse(409, "project_run.review_changed");
    const supported = reconcileOptions(reported.value);
    const editableNames = new Set(supported.map(option => option.name));
    const invalidEdit = validateOptions(edits, reported.value.filter(option => editableNames.has(option.name)));
    if (invalidEdit) return refuse(400, "option.invalid_value", { name: invalidEdit.name });
    const plan = planPreset(preset, supported, edits);
    const detail = (option: { name: string; value: string | number | boolean; defaultValue: string | number | boolean }): ReviewOption => ({
      ...option, help: reported.value.find(item => item.name === option.name)?.help ?? "", unexplained: supported.find(item => item.name === option.name)?.unexplained ?? true,
    });
    const installed = settings.get("local.package");
    const gpu = engine.kind === "remote" || installed === null ? null : !settings.get("local.forceCpu") && (isNativePackage(installed) ? installed.native.gpu : installed.container.gpu);
    const outputFlags = SERVER_OUTPUT_KEYS.filter(name => reported.value.some(option => option.name === name));
    const options: TaskOption[] = [...plan.effectiveOptions, ...outputFlags.map(name => ({ name, value: true }))];
    if (engine.kind === "local" && reported.value.some(option => option.name === "no-gpu")) options.push({ name: "no-gpu", value: gpu !== true });
    const invalid = validateOptions(options, reported.value);
    let blocked: ApiError | null = null;
    if (snapshot.wayIn !== "link" && !snapshot.photoCount) blocked = { code: "project_run.no_photos", data: {} };
    else if (facts && facts.pendingMetadata > 0) blocked = { code: "project_run.metadata_pending", data: {} };
    else if (snapshot.wayIn !== "link" && info.value.maxImages != null && snapshot.photoCount > info.value.maxImages) blocked = { code: "project_run.image_limit", data: { count: snapshot.photoCount, limit: info.value.maxImages } };
    else if (plan.unsupportedPresetOptions.length || !outputFlags.includes("tiles")) blocked = { code: "project_run.preset_unavailable", data: { names: plan.unsupportedPresetOptions.map(option => option.name) } };
    else if (invalid) blocked = { code: "option.invalid_value", data: { name: invalid.name } };
    else if (this.deps.runs.listUnfinished().some(run => run.projectId === id && run.engineId === engineId)) blocked = { code: "project_run.already_running", data: {} };
    if (archiveUnavailable && !previousTaskMissing) blocked = { code: "run.results_not_ready", data: {} };
    const revision = createHash("sha256").update(JSON.stringify({ inputs: snapshot.revision, sourceRunId, engine: engine.id, address: engine.address, version: info.value.version, engineVersion: info.value.engineVersion, limit: info.value.maxImages ?? null, reportedLimit: info.value.maxImages !== undefined, gpu, preset, reported: reported.value, options, presetName })).digest("hex");
    return { ok: true, value: { inputs: snapshot, client, options, view: {
      project: { id, name: project.name }, engine: { id: engine.id, name: engine.name, kind: engine.kind, info: info.value, gpu, imageLimit: info.value.maxImages ?? null, imageLimitReported: info.value.maxImages !== undefined },
      ...(presetName !== undefined ? { presetName } : {}),
      preset, presets: PRESET_IDS.map(value => ({ id: value, departures: planPreset(value, supported).departures.map(detail) })),
      wayIn: snapshot.wayIn, photos: snapshot.wayIn === "link" ? { included: null, excluded: null, total: null, bytes: null } : { included: snapshot.photoCount, excluded: snapshot.excludedPhotoCount, total: snapshot.totalPhotoCount, bytes: snapshot.photoBytes },
      settings: { options: supported, facts: {
        bands: facts ? facts.bands.length > 0 ? true : facts.pendingMetadata > 0 ? null : false : null,
        videos: facts ? facts.videoCount > 0 : null,
      }, matcherWarning: engine.kind === "local" && gpu === false && options.some(option => option.name === "matcher-type" && option.value === "hamming") ? reported.value.find(option => option.name === "matcher-type")?.help ?? null : null },
      facts, options: plan.departures.map(detail), outputs: plan.outputs, alwaysProduced: outputFlags, revision, blocked,
    } } };
  }

  async review(id: number, engine: number, preset: PresetId, offset: number, edits: Readonly<NonNullable<ProjectRunRequest["options"]>> = [], presetName?: string, sourceRunId?: number): Promise<Outcome<RunReviewView>> {
    const result = await this.inspect(id, engine, preset, offset, edits, presetName, sourceRunId);
    return result.ok ? { ok: true, value: result.value.view } : result;
  }

  async retry(id: number): Promise<Outcome<RunView>> {
    const { runs, engines } = this.deps;
    const original = runs.get(id);
    if (!original) return refuse(404, "run.not_found");
    if (original.sample || !["failed", "cancelled"].includes(original.state)) return refuse(409, "run.action_unavailable");
    const engine = original.engineId === null ? null : engines.get(original.engineId);
    if (!engine?.enabled || !engine.address) return refuse(409, "project_run.engine_unavailable");
    return this.repeat(original, engine.id, original.options, original.name ?? "", original.preset, original.presetName);
  }

  private async recover(id: number): Promise<boolean> {
    const { runs, tracker, engines } = this.deps;
    const run = runs.get(id), source = runs.source<SavedSource>(id);
    if (!run || isFinished(run.state) || !source || this.preparing.has(id) || this.deleting.has(id)) return false;
    const engine = run.engineId === null ? null : engines.get(run.engineId);
    if (!engine?.enabled) return false;
    const key = `${run.projectId}:${engine.id}`;
    if (this.starting.has(key)) return false;
    const release = this.deps.projectDeletion.beginWrite(run.projectId);
    if (!release) return false;
    this.starting.add(key); tracker.pause(id);
    const boundary = tracker.log(id, Number.MAX_SAFE_INTEGER).next;
    tracker.update(id, { state: source.wayIn === "link" ? "created" : "uploading", taskUuid: null, restarted: true, restartedAtLine: boundary, progress: null, restartPending: false });
    const preparing: Preparing = { abort: new AbortController(), done: Promise.resolve(), cancelFailure: null };
    this.preparing.set(id, preparing);
    const client = this.clientFor(engine);
    preparing.done = this.prepare(run.projectId, id, run.name ?? "", { client, options: run.options, inputs: source.wayIn === "link" ? source : source.snapshot, saved: source.wayIn === "link" ? undefined : source }, preparing)
      .finally(() => { this.preparing.delete(id); this.starting.delete(key); release(); });
    return true;
  }

  private hasUnsavedArchive(run: RunRecord): boolean {
    return run.state === "completed" && !["ready", "deleted"].includes(this.deps.tracker.results.view(run.id)?.state ?? "");
  }

  private async repeat(original: RunRecord, engineId: number, options: TaskOption[], name: string, preset: string | null, presetName?: string): Promise<Outcome<RunView>> {
    const { runs, tracker, engines } = this.deps;
    const key = `${original.projectId}:${engineId}`;
    if (this.deleting.has(original.id)) return refuse(409, "run.action_unavailable");
    if (this.starting.has(key) || runs.listUnfinished().some(run => run.projectId === original.projectId && run.engineId === engineId)) return refuse(409, "project_run.already_running");
    const release = this.deps.projectDeletion.beginWrite(original.projectId);
    if (!release) return refuse(409, "project.deletion_busy");
    const unblocks: Array<() => void> = [];
    this.starting.add(key);
    let handedOver = false;
    try {
      const client = this.clientFor(engines.get(engineId)!);
      if (original.engineId === engineId && original.taskUuid) {
        const previousRuns = runs.taskRuns(engineId, original.taskUuid);
        for (const previous of previousRuns) {
          const unblock = tracker.results.beginRemoval(previous.id);
          if (!unblock) return refuse(409, "run.results_not_ready");
          unblocks.push(unblock);
        }
        if (previousRuns.some(run => this.hasUnsavedArchive(run))) {
          const info = await client.taskInfo(original.taskUuid);
          if (info.ok || !isTaskNotFound(info.failure, original.taskUuid)) return refuse(409, "run.results_not_ready");
        }
      }
      this.sourcesInUse.set(original.id, (this.sourcesInUse.get(original.id) ?? 0) + 1);
      const source = runs.source<SavedSource>(original.id);
      const run = runs.create({ projectId: original.projectId, engineId, name, preset, presetName, wayIn: original.wayIn, options });
      if (source) {
        runs.saveSource(run.id, source);
        if (source.wayIn === "link") this.deps.links.recordSource(original.projectId, run.id, source.url);
      }
      const preparing: Preparing = { abort: new AbortController(), done: Promise.resolve(), cancelFailure: null };
      this.preparing.set(run.id, preparing);
      preparing.done = (async () => {
        try {
          if (original.engineId === engineId && original.taskUuid !== null) {
            runs.referenceTask(run.id, original.taskUuid);
            let submitted = false;
            const restarted = await client.restartTask(original.taskUuid, options, undefined, () => {
              preparing.abort.signal.throwIfAborted();
              runs.claimTask(run.id, engineId, original.taskUuid!);
              submitted = true;
              tracker.update(run.id, {});
            });
            if (restarted.ok) {
              tracker.update(run.id, { taskUuid: original.taskUuid });
              if (preparing.abort.signal.aborted) {
                const cancelled = await client.cancelTask(original.taskUuid);
                if (cancelled.ok || isTaskNotFound(cancelled.failure, original.taskUuid)) { this.finish(run.id, "cancelled", null); return; }
                preparing.cancelFailure = problemFromFailure(cancelled.failure);
              }
              this.preparing.delete(run.id);
              tracker.update(run.id, { state: "queued", restartPending: false }); tracker.follow(run.id); return;
            }
            if (!submitted) { this.finish(run.id, "failed", problemFromFailure(restarted.failure)); return; }
            if (restarted.failure.kind === "unreachable" || restarted.failure.kind === "bad_response") {
              if (preparing.abort.signal.aborted) {
                const cancelled = await client.cancelTask(original.taskUuid);
                if (cancelled.ok || isTaskNotFound(cancelled.failure, original.taskUuid)) { this.finish(run.id, "cancelled", null); return; }
                preparing.cancelFailure = problemFromFailure(cancelled.failure);
              }
              this.preparing.delete(run.id);
              tracker.update(run.id, { state: "engine_unreachable", restartPending: true }); tracker.follow(run.id); return;
            }
            if (!isTaskNotFound(restarted.failure, original.taskUuid)) { this.finish(run.id, "failed", problemFromFailure(restarted.failure)); return; }
          }
          if (!source) { this.finish(run.id, "failed", { code: "run.photos_unavailable", data: {} }); return; }
          tracker.update(run.id, { state: source.wayIn === "link" ? "created" : "uploading", step: source.wayIn === "link" ? null : "upload", restartPending: false });
          await this.prepare(original.projectId, run.id, name, { client, options, inputs: source.wayIn === "link" ? source : source.snapshot, saved: source.wayIn === "link" ? undefined : source }, preparing);
        } catch {
          this.finish(run.id, preparing.abort.signal.aborted ? "cancelled" : "failed", preparing.abort.signal.aborted ? null : { code: "run.upload_failed", data: {} });
        }
      })().finally(() => {
        this.preparing.delete(run.id); this.starting.delete(key);
        const count = (this.sourcesInUse.get(original.id) ?? 1) - 1;
        if (count) this.sourcesInUse.set(original.id, count); else this.sourcesInUse.delete(original.id);
        for (const unblock of unblocks) unblock(); release();
      });
      handedOver = true;
      return { ok: true, value: tracker.view(run.id)! };
    } finally {
      if (!handedOver) {
        for (const unblock of unblocks) unblock();
        this.starting.delete(key);
        release();
      }
    }
  }

  async start(id: number, request: ProjectRunRequest): Promise<Outcome<RunView>> {
    const key = `${id}:${request.engineId}`;
    if (this.starting.has(key)) return refuse(409, "project_run.already_running");
    const release = this.deps.projectDeletion.beginWrite(id);
    if (!release) return refuse(409, "project.deletion_busy");
    this.starting.add(key);
    let handedOver = false;
    let ownsStarting = true;
    try {
      const reviewed = await this.inspect(id, request.engineId, request.preset, 0, request.options, request.presetName, request.sourceRunId);
      if (!reviewed.ok) return reviewed;
      const { view } = reviewed.value;
      if (view.blocked) return { ok: false, status: 409, error: view.blocked };
      if (request.revision !== view.revision) return refuse(409, "project_run.review_changed");
      if (request.sourceRunId === undefined && (this.deps.links.isBusy(id) || (reviewed.value.inputs.wayIn === "link" && this.deps.links.revision(id) !== reviewed.value.inputs.revision))) return refuse(409, "project_run.review_changed");
      if (request.sourceRunId !== undefined) {
        this.starting.delete(key);
        ownsStarting = false;
        const original = this.deps.runs.get(request.sourceRunId);
        if (!original) return refuse(404, "run.not_found");
        return this.repeat(original, request.engineId, reviewed.value.options, request.name, request.preset, request.presetName);
      }
      let source: SavedSource;
      try { source = reviewed.value.inputs.wayIn === "link" ? reviewed.value.inputs : await this.deps.inputs.capture(id, reviewed.value.inputs); }
      catch (error) { if (error instanceof RunInputsChanged || error instanceof ImportUnavailable) return refuse(409, "project_run.photos_changed"); throw error; }
      const run = this.deps.runs.create({ projectId: id, engineId: request.engineId, name: request.name, preset: request.preset, presetName: request.presetName, wayIn: view.wayIn, options: reviewed.value.options });
      this.deps.runs.saveSource(run.id, source);
      if (view.wayIn === "link") this.deps.links.recordRun(id, run.id);
      const preparing: Preparing = { abort: new AbortController(), done: Promise.resolve(), cancelFailure: null };
      this.preparing.set(run.id, preparing);
      this.deps.tracker.update(run.id, { state: view.wayIn === "link" ? "created" : "uploading", step: view.wayIn === "link" ? null : "upload", upload: view.photos.included === null ? null : { done: 0, total: view.photos.included } });
      preparing.done = this.prepare(id, run.id, request.name, reviewed.value, preparing).finally(() => {
        this.preparing.delete(run.id); this.starting.delete(key); release();
      });
      handedOver = true;
      return { ok: true, value: this.deps.tracker.view(run.id)! };
    } finally {
      if (!handedOver) { if (ownsStarting) this.starting.delete(key); release(); }
    }
  }

  private async prepare(project: number, id: number, name: string, reviewed: Pick<Reviewed, "client" | "options" | "inputs"> & { saved?: SavedRunInputs }, preparing: Preparing): Promise<void> {
    const { tracker } = this.deps;
    const { client, options, inputs } = reviewed;
    const { signal } = preparing.abort;
    let uuid: string | null = null;
    let committed = false;
    try {
      signal.throwIfAborted();
      // Finish the bounded init request so cancellation can remove the task by its returned identity.
      const created = inputs.wayIn === "link" ? await client.createLinkedTask(name, options, inputs.url) : await client.createTask(name, options);
      if (!created.ok) { this.finish(id, signal.aborted ? "cancelled" : "failed", signal.aborted ? null : problemFromFailure(created.failure)); return; }
      uuid = created.value.uuid;
      committed = inputs.wayIn === "link";
      tracker.update(id, { taskUuid: uuid, ...(inputs.wayIn === "link" ? { state: "queued" as const } : {}) });
      if (inputs.wayIn !== "link") {
        signal.throwIfAborted();
        const progress = (done: number, total: number) => tracker.update(id, { upload: { done, total } });
        const copied = reviewed.saved
          ? await this.deps.inputs.replay(project, reviewed.saved, client, uuid, signal, progress)
          : await this.deps.inputs.copyToTask(project, inputs, client, uuid, signal, progress);
        if (!copied.ok) { this.finish(id, "failed", problemFromFailure(copied.failure)); return; }
        signal.throwIfAborted();
        const result = await client.commitTask(uuid, signal);
        if (!result.ok) { this.finish(id, signal.aborted ? "cancelled" : "failed", signal.aborted ? null : problemFromFailure(result.failure)); return; }
        committed = true;
      }
      if (signal.aborted) {
        const cancelled = await client.cancelTask(uuid);
        if (cancelled.ok || isTaskNotFound(cancelled.failure, uuid)) { this.finish(id, "cancelled", null); return; }
        preparing.cancelFailure = problemFromFailure(cancelled.failure);
      }
      // Cancellation after this point uses the tracker and the normal engine cancel route.
      this.preparing.delete(id);
      tracker.update(id, { state: "queued", step: null, upload: null });
      tracker.follow(id);
    } catch (error) {
      this.finish(id, signal.aborted ? "cancelled" : "failed", signal.aborted ? null : { code: error instanceof RunInputsChanged || error instanceof ImportUnavailable ? "project_run.photos_changed" : "run.upload_failed", data: {} });
    } finally {
      if (uuid !== null && !committed) {
        const removed = await client.removeTask(uuid);
        if (!removed.ok && !isTaskNotFound(removed.failure, uuid)) this.deps.log(`Run ${id}: could not remove its uncommitted task`);
      }
    }
  }

  private finish(id: number, state: "failed" | "cancelled", problem: ApiError | null): void {
    this.deps.tracker.update(id, { state, problem, step: null, upload: null, restartPending: false });
  }

  async cancel(id: number): Promise<Outcome<RunView> | null> {
    const preparing = this.preparing.get(id);
    if (!preparing) return null;
    preparing.abort.abort(); await preparing.done;
    if (preparing.cancelFailure) return { ok: false, status: 502, error: preparing.cancelFailure };
    return { ok: true, value: this.deps.tracker.view(id)! };
  }

  async stop(): Promise<void> {
    const all = [...this.preparing.values()];
    for (const preparing of all) preparing.abort.abort();
    await Promise.all(all.map(preparing => preparing.done));
  }

  list(project: number, offset: number): { runs: RunView[]; nextOffset: number | null } {
    const rows = this.deps.runs.list(project, offset, 51);
    return { runs: rows.slice(0, 50).map(run => this.deps.tracker.view(run.id)!), nextOffset: rows.length > 50 ? offset + 50 : null };
  }

  async delete(id: number): Promise<Outcome<void>> {
    const { runs, tracker, engines } = this.deps;
    const run = runs.get(id);
    if (!run) return refuse(404, "run.not_found");
    const key = `${run.projectId}:${run.engineId}`;
    if (this.starting.has(key) || this.sourcesInUse.has(id) || this.deleting.has(id) || this.preparing.has(id) || run.state === "created" || run.state === "uploading" || runs.listUnfinished().some(other => other.id !== id && other.engineId === run.engineId && other.taskUuid !== null && other.taskUuid === run.taskUuid)) return refuse(409, "run.action_unavailable");
    const release = this.deps.projectDeletion.beginWrite(run.projectId);
    if (!release) return refuse(409, "project.deletion_busy");
    const unblock = tracker.results.beginRemoval(id);
    if (!unblock) { release(); return refuse(409, "run.action_unavailable"); }
    this.deleting.add(id); this.starting.add(key); tracker.pause(id);
    try {
      if (run.taskUuid && !run.taskRetired) {
        const engine = run.engineId === null ? null : engines.get(run.engineId);
        if (!engine) return refuse(409, "project.deletion_engine_missing");
        const removed = await this.clientFor(engine).removeTask(run.taskUuid);
        if (!removed.ok && !isTaskNotFound(removed.failure, run.taskUuid)) return refuse(502, "project.deletion_incomplete");
      }
      await tracker.remove(run);
      return { ok: true, value: undefined };
    } catch { return refuse(502, "project.deletion_incomplete"); }
    finally { this.deleting.delete(id); this.starting.delete(key); unblock(); release(); if (runs.get(id)) tracker.follow(id); }
  }
}
