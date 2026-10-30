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
import type { RunStore } from "../runs/run-store.ts";
import type { RunTracker } from "../runs/run-tracker.ts";
import { isNativePackage, type Settings } from "../settings/settings.ts";
import { isTaskNotFound, TaskClient, type EngineEndpoint, type TaskOption } from "../task-api/task-client.ts";
import { ImportUnavailable } from "./import-store.ts";
import type { ProjectDeletion } from "./project-deletion.ts";
import type { ProjectStore } from "./project-store.ts";
import { RunInputs, RunInputsChanged, type RunInputSnapshot } from "./run-inputs.ts";

type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; error: ApiError };
function refuse(status: number, code: ApiError["code"], data: ApiError["data"] = {}): { ok: false; status: number; error: ApiError } {
  return { ok: false, status, error: { code, data } };
}
type ReviewedInputs = RunInputSnapshot | { wayIn: "link"; revision: string; url: string };
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
  private readonly starting = new Set<number>();
  private readonly clientFor: (endpoint: EngineEndpoint) => TaskClient;
  constructor(private readonly deps: Dependencies) {
    this.clientFor = deps.clientFor ?? (endpoint => new TaskClient(endpoint, { log: deps.log }));
  }

  private async inspect(id: number, engineId: number, preset: PresetId, offset: number, edits: Readonly<NonNullable<ProjectRunRequest["options"]>> = []): Promise<Outcome<Reviewed>> {
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
    let snapshot: ReviewedInputs;
    let facts;
    try {
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
    } catch (error) {
      if (error instanceof ImportUnavailable || error instanceof RunInputsChanged) return refuse(409, "project_run.photos_changed");
      throw error;
    }
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
    else if (this.deps.runs.listUnfinished().some(run => run.projectId === id)) blocked = { code: "project_run.already_running", data: {} };
    const revision = createHash("sha256").update(JSON.stringify({ inputs: snapshot.revision, engine: engine.id, address: engine.address, version: info.value.version, engineVersion: info.value.engineVersion, limit: info.value.maxImages ?? null, reportedLimit: info.value.maxImages !== undefined, gpu, preset, reported: reported.value, options })).digest("hex");
    return { ok: true, value: { inputs: snapshot, client, options, view: {
      project: { id, name: project.name }, engine: { id: engine.id, name: engine.name, kind: engine.kind, info: info.value, gpu, imageLimit: info.value.maxImages ?? null, imageLimitReported: info.value.maxImages !== undefined },
      preset, presets: PRESET_IDS.map(value => ({ id: value, departures: planPreset(value, supported).departures.map(detail) })),
      wayIn: snapshot.wayIn, photos: snapshot.wayIn === "link" ? { included: null, excluded: null, total: null, bytes: null } : { included: snapshot.photoCount, excluded: snapshot.excludedPhotoCount, total: snapshot.totalPhotoCount, bytes: snapshot.photoBytes },
      settings: { options: supported, facts: {
        bands: facts ? facts.bands.length > 0 ? true : facts.pendingMetadata > 0 ? null : false : null,
        videos: facts ? facts.videoCount > 0 : null,
      }, matcherWarning: engine.kind === "local" && gpu === false && options.some(option => option.name === "matcher-type" && option.value === "hamming") ? reported.value.find(option => option.name === "matcher-type")?.help ?? null : null },
      facts, options: plan.departures.map(detail), outputs: plan.outputs, alwaysProduced: outputFlags, revision, blocked,
    } } };
  }

  async review(id: number, engine: number, preset: PresetId, offset: number, edits: Readonly<NonNullable<ProjectRunRequest["options"]>> = []): Promise<Outcome<RunReviewView>> {
    const result = await this.inspect(id, engine, preset, offset, edits);
    return result.ok ? { ok: true, value: result.value.view } : result;
  }

  async start(id: number, request: ProjectRunRequest): Promise<Outcome<RunView>> {
    if (this.starting.has(id)) return refuse(409, "project_run.already_running");
    const release = this.deps.projectDeletion.beginWrite(id);
    if (!release) return refuse(409, "project.deletion_busy");
    this.starting.add(id);
    let handedOver = false;
    try {
      const reviewed = await this.inspect(id, request.engineId, request.preset, 0, request.options);
      if (!reviewed.ok) return reviewed;
      const { view } = reviewed.value;
      if (view.blocked) return { ok: false, status: 409, error: view.blocked };
      if (request.revision !== view.revision) return refuse(409, "project_run.review_changed");
      if (this.deps.links.isBusy(id) || (reviewed.value.inputs.wayIn === "link" && this.deps.links.revision(id) !== reviewed.value.inputs.revision)) return refuse(409, "project_run.review_changed");
      const run = this.deps.runs.create({ projectId: id, engineId: request.engineId, name: request.name, preset: request.preset, wayIn: view.wayIn, options: reviewed.value.options });
      if (view.wayIn === "link") this.deps.links.recordRun(id, run.id);
      const preparing: Preparing = { abort: new AbortController(), done: Promise.resolve(), cancelFailure: null };
      this.preparing.set(run.id, preparing);
      this.deps.tracker.update(run.id, { state: view.wayIn === "link" ? "created" : "uploading", step: view.wayIn === "link" ? null : "upload", upload: view.photos.included === null ? null : { done: 0, total: view.photos.included } });
      preparing.done = this.prepare(id, run.id, request.name, reviewed.value, preparing).finally(() => {
        this.preparing.delete(run.id); this.starting.delete(id); release();
      });
      handedOver = true;
      return { ok: true, value: this.deps.tracker.view(run.id)! };
    } finally {
      if (!handedOver) { this.starting.delete(id); release(); }
    }
  }

  private async prepare(project: number, id: number, name: string, reviewed: Reviewed, preparing: Preparing): Promise<void> {
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
        const copied = await this.deps.inputs.copyToTask(project, inputs, client, uuid, signal, (done, total) => tracker.update(id, { upload: { done, total } }));
        if (!copied.ok) { this.finish(id, "failed", problemFromFailure(copied.failure)); return; }
        signal.throwIfAborted();
        const result = await client.commitTask(uuid, signal);
        if (!result.ok) { this.finish(id, signal.aborted ? "cancelled" : "failed", signal.aborted ? null : problemFromFailure(result.failure)); return; }
        committed = true;
      }
      if (signal.aborted) {
        const cancelled = await client.cancelTask(uuid);
        if (cancelled.ok || isTaskNotFound(cancelled.failure)) { this.finish(id, "cancelled", null); return; }
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
        if (!removed.ok && !isTaskNotFound(removed.failure)) this.deps.log(`Run ${id}: could not remove its uncommitted task`);
      }
    }
  }

  private finish(id: number, state: "failed" | "cancelled", problem: ApiError | null): void {
    this.deps.tracker.update(id, { state, problem, step: null, upload: null });
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
}
