import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { ImportStore, ImportUnavailable, type SavedImport } from "./import-store.ts";
import type { TaskApiResult, TaskClient } from "../task-api/task-client.ts";

export type RunInputSnapshot = {
  wayIn: "upload" | "import";
  photoCount: number;
  excludedPhotoCount: number;
  totalPhotoCount: number;
  photoBytes: number;
  revision: string;
};

export class RunInputsChanged extends Error {
  constructor() { super("Run inputs changed"); }
}

type UploadEntry = { name: string; kind: string; sha256: string; size: number; storageId: string; excluded: number };
export type SavedRunInputs = { snapshot: RunInputSnapshot; importMode?: "copy" | "in-place" } & ({ wayIn: "upload"; entries: UploadEntry[] } | { wayIn: "import"; imported: SavedImport });
const success: TaskApiResult<void> = { ok: true, value: undefined };

function abort(signal?: AbortSignal): void { signal?.throwIfAborted(); }
function stem(name: string): string { return name.slice(0, -extname(name).length); }
function preferred(left: UploadEntry, right: UploadEntry): number {
  return Number(/\.(raw|bmp)$/i.test(left.name)) - Number(/\.(raw|bmp)$/i.test(right.name)) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

export class RunInputs {
  constructor(private readonly db: Database, private readonly folder: string, private readonly imports: ImportStore) {}

  private uploads(id: number): UploadEntry[] {
    return this.db.query(`SELECT a.name,a.kind,a.sha256,f.size,f.storage_id AS storageId,
      CASE WHEN x.sha256 IS NULL THEN 0 ELSE 1 END AS excluded
      FROM project_upload_aliases a JOIN project_upload_files f ON f.project_id=a.project_id AND f.sha256=a.sha256
      LEFT JOIN project_photo_exclusions x ON x.project_id=a.project_id AND x.sha256=a.sha256
      WHERE a.project_id=? ORDER BY a.kind,a.name,a.sha256`).all(id) as UploadEntry[];
  }

  private chosen(entries: UploadEntry[]): UploadEntry[] {
    const selected = new Map<string, UploadEntry>();
    for (const entry of entries.filter(item => item.kind === "photo" || item.kind === "video")) {
      const key = `${entry.kind}:${entry.sha256}`;
      const previous = selected.get(key);
      if (!previous || preferred(entry, previous) < 0) selected.set(key, entry);
    }
    const chosen = [...selected.values()].filter(entry => entry.kind !== "photo" || !entry.excluded);
    const photoStems = new Set(chosen.filter(entry => entry.kind === "photo").map(entry => stem(entry.name)));
    return [...chosen, ...entries.filter(entry => entry.kind === "mask" && photoStems.has(stem(entry.name).slice(0, -5)))].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.sha256.localeCompare(right.sha256));
  }

  async snapshot(id: number): Promise<RunInputSnapshot> {
    const imported = this.imports.has(id);
    if (imported) await this.imports.assertReady(id);
    const generation = imported ? this.db.query("SELECT generation FROM project_imports WHERE project_id=?").get(id) as { generation: string } | null : null;
    if (imported && !generation) throw new ImportUnavailable("changed");
    const entries = imported
      ? this.db.query("SELECT name,kind,size,sha256,signature FROM project_import_entries WHERE project_id=? AND generation=? ORDER BY name").all(id, generation!.generation)
      : this.uploads(id);
    const uploads = imported ? [] : entries as UploadEntry[];
    const photos = imported ? this.imports.photoRows(id) : this.chosen(uploads.map(entry => ({ ...entry, excluded: 0 }))).filter(entry => entry.kind === "photo").map(entry => ({ ...entry, excluded: uploads.find(item => item.sha256 === entry.sha256 && item.kind === "photo")!.excluded }));
    const included = photos.filter(photo => !photo.excluded);
    const revision = createHash("sha256").update(JSON.stringify({ imported, generation: generation?.generation, entries, photos: photos.map(photo => [photo.name, photo.sha256, photo.size, photo.excluded]) })).digest("hex");
    return { wayIn: imported ? "import" : "upload", photoCount: included.length, excludedPhotoCount: photos.length - included.length, totalPhotoCount: photos.length, photoBytes: included.reduce((total, photo) => total + photo.size, 0), revision };
  }

  private async check(id: number, snapshot: RunInputSnapshot): Promise<void> {
    if ((await this.snapshot(id)).revision !== snapshot.revision) throw new RunInputsChanged();
  }

  async capture(id: number, snapshot: RunInputSnapshot): Promise<SavedRunInputs> {
    await this.check(id, snapshot);
    const saved: SavedRunInputs = snapshot.wayIn === "import"
      ? { wayIn: "import", snapshot, imported: await this.imports.capture(id) }
      : { wayIn: "upload", snapshot, entries: this.chosen(this.uploads(id)) };
    await this.check(id, snapshot);
    return saved;
  }

  async inPlacePath(saved: SavedRunInputs): Promise<string | null> {
    return saved.wayIn === "import" ? this.imports.inPlacePath(saved.imported) : null;
  }

  async verifyInPlace(saved: SavedRunInputs, signal?: AbortSignal): Promise<void> {
    if (saved.wayIn !== "import") throw new RunInputsChanged();
    await this.imports.verifyInPlace(saved.imported, signal);
  }

  async replay(id: number, saved: SavedRunInputs, client: TaskClient, uuid: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<TaskApiResult<void>> {
    if (saved.wayIn === "import") {
      const result = await this.imports.replay(saved.imported, client, uuid, signal);
      if (result.ok) onProgress?.(saved.snapshot.photoCount, saved.snapshot.photoCount);
      return result;
    }
    return this.copyUploads(id, saved.snapshot, saved.entries, client, uuid, signal, onProgress);
  }

  private async verify(file: Awaited<ReturnType<typeof open>>, entry: UploadEntry, signal?: AbortSignal): Promise<void> {
    const info = await file.stat();
    if (!info.isFile() || info.size !== entry.size) throw new RunInputsChanged();
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (position < entry.size) {
      abort(signal);
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, entry.size - position), position);
      if (!bytesRead) throw new RunInputsChanged();
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    if ((await file.stat()).size !== entry.size || hash.digest("hex") !== entry.sha256) throw new RunInputsChanged();
  }

  async copyToTask(id: number, snapshot: RunInputSnapshot, client: TaskClient, uuid: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<TaskApiResult<void>> {
    abort(signal);
    await this.check(id, snapshot);
    if (snapshot.wayIn === "import") {
      const result = await this.imports.copyToTask(id, client, uuid, signal);
      abort(signal); await this.check(id, snapshot);
      if (result.ok) onProgress?.(snapshot.photoCount, snapshot.photoCount);
      return result;
    }
    return this.copyUploads(id, snapshot, this.chosen(this.uploads(id)), client, uuid, signal, onProgress, () => this.check(id, snapshot));
  }

  private async copyUploads(id: number, snapshot: RunInputSnapshot, selected: UploadEntry[], client: TaskClient, uuid: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void, check: () => Promise<void> = async () => {}): Promise<TaskApiResult<void>> {
    const photos = selected.filter(entry => entry.kind === "photo");
    const named = new Map<string, UploadEntry>();
    for (const entry of selected) {
      const matching = entry.kind === "mask" ? photos.filter(photo => stem(photo.name) === stem(entry.name).slice(0, -5)) : [entry];
      for (const photo of matching) {
        const prefix = createHash("sha256").update(JSON.stringify([stem(photo.name), photo.sha256])).digest("hex");
        const name = prefix + (entry.kind === "mask" ? "_mask" : "") + extname(entry.name);
        if (!named.has(name)) named.set(name, entry);
      }
    }
    let done = 0;
    for (const [name, entry] of named) {
      abort(signal);
      if (!/^[a-f0-9]{32}$/.test(entry.storageId)) throw new RunInputsChanged();
      const directory = resolve(this.folder, "projects", String(id), "files");
      const path = join(directory, entry.storageId);
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        if (await realpath(directory) !== directory || (await lstat(path)).isSymbolicLink()) throw new RunInputsChanged();
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        await this.verify(file, entry, signal);
        const result = await client.uploadImage(uuid, name, Bun.file(file.fd), signal);
        abort(signal);
        await this.verify(file, entry, signal);
        const current = await lstat(path);
        const opened = await file.stat();
        if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino || await realpath(directory) !== directory) throw new RunInputsChanged();
        await check();
        if (!result.ok) return result;
        if (entry.kind === "photo") onProgress?.(++done, snapshot.photoCount);
      } catch (error) {
        abort(signal);
        if (error instanceof RunInputsChanged || error instanceof ImportUnavailable) throw error;
        if ((error as NodeJS.ErrnoException)?.code) throw new RunInputsChanged();
        throw error;
      } finally { await file?.close(); }
    }
    abort(signal); await check();
    return success;
  }
}
