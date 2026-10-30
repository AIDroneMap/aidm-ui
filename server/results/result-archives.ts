import { existsSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunMapView } from "../../shared/map.ts";
import { readMapMetadata } from "./map-metadata.ts";
import type { RunResultsView } from "../../shared/api-types.ts";
import { downloadArchive } from "../downloads/downloader.ts";
import type { RunRecord, RunStore } from "../runs/run-store.ts";
import type { DownloadRequest } from "../downloads/downloader.ts";
import { entryBody, readArchive, type ArchiveEntry } from "./zip.ts";

const OUTPUTS: Record<string, { path: string; type: string }> = {
  orthophoto: { path: "odm_orthophoto/odm_orthophoto.tif", type: "image/tiff" },
  surface: { path: "odm_dem/dsm.tif", type: "image/tiff" },
  ground: { path: "odm_dem/dtm.tif", type: "image/tiff" },
  "point-cloud": { path: "odm_georeferencing/odm_georeferenced_model.laz", type: "application/octet-stream" },
  "textured-model": { path: "odm_texturing/odm_textured_model_geo.obj", type: "text/plain" },
  glb: { path: "odm_texturing/odm_textured_model_geo.glb", type: "model/gltf-binary" },
  report: { path: "odm_report/report.pdf", type: "application/pdf" },
};
interface SavedResults { state: RunResultsView["state"]; archiveSize: number | null; entries: ArchiveEntry[] }

/** Owns the local archive. Engine completion and local availability are separate facts. */
export class ResultArchives {
  private readonly active = new Map<number, Promise<void>>();
  private readonly controller = new AbortController();
  constructor(private readonly deps: {
    runs: RunStore; folder: string; request: (run: RunRecord) => DownloadRequest;
    changed: (id: number) => void; log: (line: string) => void;
    beginWrite: (projectId: number) => (() => void) | null;
  }) {}

  path(run: RunRecord): string { return join(this.deps.folder, "projects", String(run.projectId), "runs", String(run.id), "results.zip"); }

  view(id: number): RunResultsView | undefined {
    let saved = this.deps.runs.results<SavedResults>(id);
    if (saved?.state === "ready") {
      const run = this.deps.runs.get(id);
      const path = run ? this.path(run) : "";
      if (!existsSync(path) || statSync(path).size !== saved.archiveSize) {
        saved = { state: "failed", archiveSize: null, entries: [] };
        this.deps.runs.saveResults(id, saved);
      }
    }
    if (saved === null) return undefined;
    return { state: saved.state, archiveSize: saved.archiveSize, outputs: saved.state === "ready" ? Object.entries(OUTPUTS).flatMap(([name, output]) => {
      const entry = saved.entries.find(entry => entry.name === output.path);
      return entry ? [{ name, size: entry.size }] : [];
    }) : [] };
  }

  /** Already validated members for internal readers, subject to the same saved-file check as downloads. */
  indexedEntries(id: number): readonly ArchiveEntry[] | null {
    if (this.view(id)?.state !== "ready") return null;
    return this.deps.runs.results<SavedResults>(id)?.entries ?? null;
  }

  async map(run: RunRecord): Promise<RunMapView> {
    const unavailable: RunMapView = { state: "unavailable", layers: [] };
    const entries = this.indexedEntries(run.id);
    if (!entries) return unavailable;
    try {
      const view = await readMapMetadata(this.path(run), entries);
      return this.view(run.id)?.state === "ready" ? view : unavailable;
    } catch { return unavailable; }
  }

  ensure(run: RunRecord, retry = false): boolean {
    if (this.controller.signal.aborted || this.active.has(run.id) || run.state !== "completed" || run.taskUuid === null) return false;
    const saved = this.view(run.id);
    if (saved && !(saved.state === "fetching" || (retry && saved.state === "failed"))) return false;
    const release = this.deps.beginWrite(run.projectId);
    if (release === null) return false;
    this.save(run.id, { state: "fetching", archiveSize: null, entries: [] });
    const work = this.fetch(run).finally(() => { this.active.delete(run.id); release(); });
    this.active.set(run.id, work);
    return true;
  }

  private save(id: number, value: SavedResults): void {
    this.deps.runs.saveResults(id, value);
    this.deps.changed(id);
  }

  private async fetch(run: RunRecord): Promise<void> {
    const path = this.path(run);
    const part = `${path}.part`;
    try {
      await mkdir(join(path, ".."), { recursive: true });
      // A crash after the rename can leave a complete file before the ready record.
      let entries: ArchiveEntry[] | undefined;
      if (existsSync(path)) {
        try { entries = await readArchive(path, this.controller.signal); }
        catch {
          this.controller.signal.throwIfAborted();
          await rm(path, { force: true });
        }
      }
      if (entries === undefined) {
        await downloadArchive(part, this.deps.request(run), this.controller.signal);
        try { entries = await readArchive(part, this.controller.signal); }
        catch (error) {
          this.controller.signal.throwIfAborted();
          await rm(part, { force: true });
          throw error;
        }
        this.controller.signal.throwIfAborted();
        await rename(part, path);
      }
      this.controller.signal.throwIfAborted();
      this.save(run.id, { state: "ready", archiveSize: statSync(path).size, entries });
    } catch {
      if (this.controller.signal.aborted) return;
      this.deps.log(`Run ${run.id}: fetching or validating the results archive failed.`);
      this.save(run.id, { state: "failed", archiveSize: null, entries: [] });
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await Promise.all(this.active.values());
  }

  async delete(run: RunRecord): Promise<boolean> {
    if (this.active.has(run.id)) return false;
    const release = this.deps.beginWrite(run.projectId);
    if (release === null) return false;
    try {
      // Persist intent first, so a restart never fetches deleted results again.
      this.save(run.id, { state: "deleted", archiveSize: null, entries: [] });
      await rm(this.path(run), { force: true });
      await rm(`${this.path(run)}.part`, { force: true });
      return true;
    } finally { release(); }
  }

  response(run: RunRecord, request: Request, output?: string, tile?: string): Response | null {
    const saved = this.deps.runs.results<SavedResults>(run.id);
    if (saved?.state !== "ready") return null;
    const path = this.path(run);
    if (!existsSync(path) || statSync(path).size !== saved.archiveSize) return null;
    const known = output === undefined ? undefined : OUTPUTS[output];
    if (output !== undefined && known === undefined) return new Response(null, { status: 404 });
    const entry = output !== undefined || tile !== undefined ? saved.entries.find(entry => entry.name === (known?.path ?? tile)) : undefined;
    if ((output !== undefined || tile !== undefined) && entry === undefined) return new Response(null, { status: 404 });
    const size = entry?.size ?? saved.archiveSize!;
    const type = known?.type ?? (tile ? "image/png" : "application/zip");
    const headers = new Headers({ "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Length": String(size) });
    if (!tile) headers.set("Content-Disposition", `attachment; filename="${known ? known.path.split("/").at(-1)! : `run-${run.id}-results.zip`}"`);
    const range = request.headers.get("range");
    if (entry?.method !== 8) {
      headers.set("Accept-Ranges", "bytes");
      if (range !== null) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]));
        const end = match?.[1] && match?.[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
          headers.set("Content-Range", `bytes */${size}`); headers.delete("Content-Length");
          return new Response(null, { status: 416, headers });
        }
        headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
        headers.set("Content-Length", String(end - start + 1));
        return new Response(Bun.file(path).slice((entry?.offset ?? 0) + start, (entry?.offset ?? 0) + end + 1), { status: 206, headers });
      }
    }
    return new Response(entry ? entryBody(path, entry) : Bun.file(path), { headers });
  }
}
