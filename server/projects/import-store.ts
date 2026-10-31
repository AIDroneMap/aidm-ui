import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BigIntStats } from "node:fs";
import type { Database } from "bun:sqlite";
import { classifyUploadFile } from "../../shared/upload-files.ts";
import { readPhotoMetadata } from "../photos/metadata.ts";
import type { TaskClient } from "../task-api/task-client.ts";
import type { TaskApiResult } from "../task-api/task-client.ts";

type State = "changed" | "missing";
type Kind = "photo" | "mask" | "video";
type Header = { path: string; generation: string; acceptedCount: number; skippedCount: number; groundControlCount: number };
type Entry = { name: string; kind: string; size: number; signature: string; sha256: string | null };
export interface SavedImport { path: string; entries: Entry[] }
export class ImportUnavailable extends Error {
  constructor(public readonly state: State) { super(`Import ${state}`); }
}
function signature(s: BigIntStats): string { return [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":"); }
function contentIdentity(value: string): string { return value.slice(0, value.lastIndexOf(":")); }
function within(parent: string, child: string): boolean { const r = relative(parent, child); return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r)); }
function unavailable(error: unknown): ImportUnavailable {
  return error instanceof ImportUnavailable ? error : new ImportUnavailable((error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "changed");
}
function readerKind(name: string): string { return /\.(raw|bmp)$/i.test(name) ? "unsupported" : "container"; }

export class ImportStore {
  private readonly busy = new Set<number>();
  constructor(private readonly db: Database, private readonly dataFolder: string) {
    this.db.run("DELETE FROM project_import_entries WHERE NOT EXISTS (SELECT 1 FROM project_imports i WHERE i.project_id = project_import_entries.project_id AND i.generation = project_import_entries.generation)");
  }
  private header(id: number): Header | null {
    return this.db.query("SELECT path, generation, accepted_count AS acceptedCount, skipped_count AS skippedCount, ground_control_count AS groundControlCount FROM project_imports WHERE project_id = ?").get(id) as Header | null;
  }
  has(id: number): boolean { return this.header(id) !== null; }
  isBusy(id: number): boolean { return this.busy.has(id); }
  private async dataPath(): Promise<string> {
    let path = resolve(this.dataFolder), suffix = "";
    for (;;) {
      try { return join(await realpath(path), suffix); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error; suffix = join(basename(path), suffix); path = dirname(path); }
    }
  }
  private async safePath(root: string, name: string): Promise<string> {
    const path = join(root, name);
    if (!within(root, path)) throw new ImportUnavailable("changed");
    if (await realpath(root) !== root) throw new ImportUnavailable("changed");
    let current = root;
    const rootInfo = await lstat(root, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new ImportUnavailable("changed");
    for (const part of name.split(sep).filter(Boolean)) {
      current = join(current, part);
      const info = await lstat(current, { bigint: true });
      if (info.isSymbolicLink()) throw new ImportUnavailable("changed");
      if (current !== path && !info.isDirectory()) throw new ImportUnavailable("changed");
    }
    return path;
  }
  private async digest(root: string, entry: Entry): Promise<void> {
    const path = await this.safePath(root, entry.name);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || contentIdentity(signature(before)) !== contentIdentity(entry.signature)) throw new ImportUnavailable("changed");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let position = 0;
      while (position < entry.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, entry.size - position), position);
        if (!bytesRead) throw new ImportUnavailable("changed");
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      if ((await file.read(buffer, 0, 1, position)).bytesRead !== 0) throw new ImportUnavailable("changed");
      if (signature(await file.stat({ bigint: true })) !== signature(before) || position !== entry.size) throw new ImportUnavailable("changed");
      if (entry.sha256 !== null && hash.digest("hex") !== entry.sha256) throw new ImportUnavailable("changed");
      if (entry.sha256 === null) entry.sha256 = hash.digest("hex");
      const after = await lstat(await this.safePath(root, entry.name), { bigint: true });
      if (signature(after) !== signature(before)) throw new ImportUnavailable("changed");
      entry.signature = signature(after);
    } finally { await file.close(); }
  }
  async select(id: number, input: string): Promise<"ok" | "invalid_path" | "unreadable" | "busy" | "uploads_present"> {
    if (this.busy.has(id)) return "busy";
    if (!isAbsolute(input) || input.includes("\0")) return "invalid_path";
    if (this.db.query("SELECT 1 FROM project_uploads WHERE project_id = ? LIMIT 1").get(id) || this.db.query("SELECT 1 FROM project_upload_aliases WHERE project_id = ? LIMIT 1").get(id)) return "uploads_present";
    if (!this.has(id) && this.db.query("SELECT 1 FROM projects WHERE id = ? AND photo_count > 0").get(id)) return "uploads_present";
    this.busy.add(id);
    const generation = randomBytes(16).toString("hex");
    try {
      let root: string;
      try { root = await realpath(input); } catch { return "invalid_path"; }
      const data = await this.dataPath();
      if (within(root, data) || within(data, root)) return "invalid_path";
      const info = await lstat(root, { bigint: true });
      if (!info.isDirectory()) return "invalid_path";
      let accepted = 0, skipped = 0, ground = 0;
      const insert = this.db.query("INSERT INTO project_import_entries (project_id, generation, name, kind, size, signature, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const walk = async (name: string, depth: number): Promise<void> => {
        if (depth > 64) throw new Error("Folder depth limit");
        const path = await this.safePath(root, name);
        const before = await lstat(path, { bigint: true });
        if (!before.isDirectory()) throw new Error("Folder changed");
        insert.run(id, generation, name, "directory", Number(before.size), signature(before), null);
        const directory = await opendir(path);
        for await (const child of directory) {
          const childName = name ? join(name, child.name) : child.name;
          const childPath = join(path, child.name);
          const stat = await lstat(childPath, { bigint: true });
          if (stat.isSymbolicLink()) { skipped++; continue; }
          if (stat.isDirectory()) { await walk(childName, depth + 1); continue; }
          if (!stat.isFile()) { skipped++; continue; }
          const kind = classifyUploadFile(childName);
          if (kind === "ground_control") { ground++; continue; }
          if (kind === "unsupported") { skipped++; continue; }
          const size = Number(stat.size);
          if (!Number.isSafeInteger(size)) throw new Error("File too large");
          const entry: Entry = { name: childName, kind, size, signature: signature(stat), sha256: null };
          await this.digest(root, entry);
          insert.run(id, generation, name ? childName : child.name, kind, size, entry.signature, entry.sha256);
          accepted++;
        }
        if (signature(await lstat(await this.safePath(root, name), { bigint: true })) !== signature(before)) throw new Error("Folder changed");
      };
      await walk("", 0);
      await this.validate(root, id, generation);
      if (this.db.query("SELECT 1 FROM project_uploads WHERE project_id = ? LIMIT 1").get(id)) return "uploads_present";
      this.db.transaction(() => {
        this.db.query("INSERT INTO project_imports VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET path=excluded.path, generation=excluded.generation, accepted_count=excluded.accepted_count, skipped_count=excluded.skipped_count, ground_control_count=excluded.ground_control_count").run(id, root, generation, accepted, skipped, ground);
        this.db.query("DELETE FROM project_import_entries WHERE project_id = ? AND generation <> ?").run(id, generation);
        this.db.query("UPDATE projects SET photo_count = (SELECT COUNT(DISTINCT sha256) FROM project_import_entries WHERE project_id = ? AND generation = ? AND kind = 'photo'), updated_at = ? WHERE id = ?").run(id, generation, new Date().toISOString(), id);
      })();
      return "ok";
    } catch { return "unreadable"; }
    finally { this.db.query("DELETE FROM project_import_entries WHERE project_id = ? AND generation = ? AND NOT EXISTS (SELECT 1 FROM project_imports WHERE project_id = ? AND generation = ?)").run(id, generation, id, generation); this.busy.delete(id); }
  }
  private async validate(root: string, id: number, generation: string): Promise<void> {
    try {
      const data = await this.dataPath();
      if (within(root, data) || within(data, root)) throw new ImportUnavailable("changed");
      const statement = this.db.query("SELECT name, kind, size, signature, sha256 FROM project_import_entries WHERE project_id = ? AND generation = ? AND name >= ? ORDER BY name LIMIT 1");
      let next = "";
      for (;;) {
        const row = statement.get(id, generation, next) as Entry | null;
        if (!row) break;
        const path = await this.safePath(root, row.name);
        const info = await lstat(path, { bigint: true });
        if (row.kind === "directory" ? !info.isDirectory() : !info.isFile()) throw new ImportUnavailable("changed");
        if (signature(info) !== row.signature) {
          // Linking changes ctime. Verify the bytes before accepting that metadata change.
          if (row.kind === "directory" || contentIdentity(signature(info)) !== contentIdentity(row.signature)) throw new ImportUnavailable("changed");
          const previous = row.signature;
          await this.digest(root, row);
          this.db.query("UPDATE project_import_entries SET signature=? WHERE project_id=? AND generation=? AND name=? AND signature=?").run(row.signature, id, generation, row.name, previous);
        }
        next = `${row.name}\0`;
      }
    } catch (error) { throw unavailable(error); }
  }
  async assertReady(id: number): Promise<void> {
    const h = this.header(id);
    if (h) {
      await this.validate(h.path, id, h.generation);
      if (this.header(id)?.generation !== h.generation) throw new ImportUnavailable("changed");
    }
  }
  async view(id: number, offset: number, limit: number) {
    const h = this.header(id);
    if (!h) return { state: "none" as const, path: null, acceptedCount: 0, skippedCount: 0, groundControlCount: 0, files: [], nextOffset: null };
    let state: "ready" | State = "ready";
    try { await this.assertReady(id); } catch (error) { state = unavailable(error).state; }
    const files = this.db.query("SELECT name, size, kind FROM project_import_entries WHERE project_id = ? AND generation = ? AND kind <> 'directory' ORDER BY name LIMIT ? OFFSET ?").all(id, h.generation, limit + 1, offset) as Array<{name:string;size:number;kind:Kind}>;
    return { state, path: h.path, acceptedCount: h.acceptedCount, skippedCount: h.skippedCount, groundControlCount: h.groundControlCount, files: files.slice(0, limit), nextOffset: files.length > limit ? offset + limit : null };
  }
  photoRows(id: number): Array<{sha256:string;size:number;name:string;readerKind:string|null;facts:string|null;excluded:number}> {
    const h = this.header(id); if (!h) return [];
    return this.db.query(`SELECT e.sha256, e.size, e.name, f.reader_kind AS readerKind, f.facts, COALESCE(f.excluded, 0) AS excluded FROM project_import_entries e LEFT JOIN project_import_facts f ON f.project_id=e.project_id AND f.sha256=e.sha256 WHERE e.project_id=? AND e.generation=? AND e.kind='photo' AND e.name=(SELECT a.name FROM project_import_entries a WHERE a.project_id=e.project_id AND a.generation=e.generation AND a.kind='photo' AND a.sha256=e.sha256 ORDER BY CASE WHEN lower(a.name) GLOB '*.raw' OR lower(a.name) GLOB '*.bmp' THEN 1 ELSE 0 END, a.name LIMIT 1) ORDER BY e.sha256`).all(id, h.generation) as ReturnType<ImportStore["photoRows"]>;
  }
  counts(id: number): {photoAliases:number;videoCount:number} {
    const h = this.header(id); if (!h) return { photoAliases: 0, videoCount: 0 };
    return this.db.query("SELECT COUNT(CASE WHEN kind='photo' THEN 1 END) AS photoAliases, COUNT(DISTINCT CASE WHEN kind='video' THEN sha256 END) AS videoCount FROM project_import_entries WHERE project_id=? AND generation=?").get(id, h.generation) as {photoAliases:number;videoCount:number};
  }
  async prepareMetadata(id: number): Promise<void> {
    const h = this.header(id); if (!h) return;
    await this.assertReady(id);
    for (const row of this.photoRows(id).filter(r => r.facts === null || r.readerKind !== readerKind(r.name)).slice(0, 32)) {
      try {
        const entry = this.db.query("SELECT name, kind, size, signature, sha256 FROM project_import_entries WHERE project_id=? AND generation=? AND name=?").get(id, h.generation, row.name) as Entry;
        await this.digest(h.path, entry);
        const facts = await readPhotoMetadata(await this.safePath(h.path, row.name), row.name);
        await this.digest(h.path, entry);
        await this.assertReady(id);
        if (this.header(id)?.generation !== h.generation) throw new ImportUnavailable("changed");
        this.db.query("INSERT INTO project_import_facts(project_id,sha256,reader_kind,facts) VALUES (?,?,?,?) ON CONFLICT(project_id,sha256) DO UPDATE SET reader_kind=excluded.reader_kind,facts=excluded.facts").run(id, row.sha256, readerKind(row.name), JSON.stringify(facts));
      } catch (error) { throw unavailable(error); }
    }
  }
  setExcluded(id: number, checksums: string[], excluded: boolean): void {
    this.db.transaction(() => {
      for (const hash of checksums) this.db.query("INSERT INTO project_import_facts(project_id,sha256,excluded) VALUES (?,?,?) ON CONFLICT(project_id,sha256) DO UPDATE SET excluded=excluded.excluded").run(id, hash, excluded ? 1 : 0);
      this.db.query("UPDATE projects SET updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    })();
  }
  private chosenEntry(id: number, generation: string, entry: Entry): boolean {
    const first = this.db.query(`SELECT e.name, COALESCE(f.excluded,0) AS excluded FROM project_import_entries e
      LEFT JOIN project_import_facts f ON f.project_id=e.project_id AND f.sha256=e.sha256
      WHERE e.project_id=? AND e.generation=? AND e.kind=? AND e.sha256=?
      ORDER BY CASE WHEN lower(e.name) GLOB '*.raw' OR lower(e.name) GLOB '*.bmp' THEN 1 ELSE 0 END, e.name LIMIT 1`)
      .get(id, generation, entry.kind, entry.sha256) as { name: string; excluded: number };
    return first.name === entry.name && (entry.kind !== "photo" || first.excluded === 0);
  }
  // A drift failure leaves an uncommitted task. The caller must discard it and never commit it.
  async capture(id: number): Promise<SavedImport> {
    const h = this.header(id);
    if (!h || this.busy.has(id)) throw new ImportUnavailable("changed");
    await this.assertReady(id);
    const rows = this.db.query("SELECT name,kind,size,signature,sha256 FROM project_import_entries WHERE project_id=? AND generation=? AND kind<>'directory' ORDER BY name").all(id, h.generation) as Entry[];
    const selected = rows.filter(entry => (entry.kind === "photo" || entry.kind === "video") && this.chosenEntry(id, h.generation, entry));
    const photoStems = new Set(selected.filter(entry => entry.kind === "photo").map(entry => entry.name.slice(0, -extname(entry.name).length)));
    const allPhotoStems = new Set(rows.filter(entry => entry.kind === "photo").map(entry => entry.name.slice(0, -extname(entry.name).length)));
    const entries = [...selected, ...rows.filter(entry => {
      if (entry.kind !== "mask") return false;
      const stem = entry.name.slice(0, -extname(entry.name).length - "_mask".length);
      return !allPhotoStems.has(stem) || photoStems.has(stem);
    })].sort((a, b) => a.name.localeCompare(b.name));
    if (this.header(id)?.generation !== h.generation) throw new ImportUnavailable("changed");
    return { path: h.path, entries };
  }

  async inPlacePath(saved: SavedImport): Promise<string | null> {
    try {
      if (!saved.entries.length || saved.entries.some(entry => entry.name.includes("/") || entry.name.includes("\\"))) return null;
      if (await realpath(saved.path) !== saved.path) throw new ImportUnavailable("changed");
      const selected = new Set(saved.entries.map(entry => entry.name));
      const names = (await readdir(saved.path)).filter(name => /\.(jpe?g|png|tiff?|bmp|raw|dng|nef|jxl|mp4|mov|lrv|ts)$/i.test(name));
      if (names.length !== selected.size || names.some(name => !selected.has(name))) return null;
      for (const name of names) {
        const info = await lstat(join(saved.path, name));
        if (!info.isFile() || info.isSymbolicLink()) return null;
      }
      return saved.path;
    } catch (error) { throw unavailable(error); }
  }

  async verifyInPlace(saved: SavedImport, signal?: AbortSignal): Promise<void> {
    try {
      if (await this.inPlacePath(saved) === null) throw new ImportUnavailable("changed");
      for (const entry of saved.entries) { signal?.throwIfAborted(); await this.digest(saved.path, entry); }
      if (await this.inPlacePath(saved) === null) throw new ImportUnavailable("changed");
    } catch (error) { signal?.throwIfAborted(); throw unavailable(error); }
  }

  async replay(saved: SavedImport, client: TaskClient, uuid: string, signal?: AbortSignal): Promise<TaskApiResult<void>> {
    try {
      const data = await this.dataPath();
      if (within(saved.path, data) || within(data, saved.path)) throw new ImportUnavailable("changed");
      for (const entry of saved.entries) {
        signal?.throwIfAborted();
        await this.digest(saved.path, entry);
        const path = await this.safePath(saved.path, entry.name);
        const extension = extname(entry.name), stem = entry.name.slice(0, -extension.length);
        const paired = entry.kind === "mask" ? stem.slice(0, -"_mask".length) : stem;
        const name = createHash("sha256").update(paired).digest("hex") + (entry.kind === "mask" ? "_mask" : "") + extension;
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (signature(await file.stat({ bigint: true })) !== entry.signature) throw new ImportUnavailable("changed");
          const result = await client.uploadImage(uuid, name, Bun.file(file.fd), signal);
          if (signature(await file.stat({ bigint: true })) !== entry.signature) throw new ImportUnavailable("changed");
          await this.digest(saved.path, entry);
          if (!result.ok) return result;
        } finally { await file.close(); }
      }
      for (const entry of saved.entries) { signal?.throwIfAborted(); await this.digest(saved.path, entry); }
      return { ok: true, value: undefined };
    } catch (error) { signal?.throwIfAborted(); throw unavailable(error); }
  }

  async copyToTask(id: number, client: TaskClient, uuid: string, signal?: AbortSignal): Promise<TaskApiResult<void>> {
    const h = this.header(id); if (!h) throw new ImportUnavailable("missing");
    if (this.busy.has(id)) throw new ImportUnavailable("changed");
    this.busy.add(id);
    try {
      await this.assertReady(id);
      const statement = this.db.query(`SELECT e.name,e.kind,e.size,e.signature,e.sha256 FROM project_import_entries e LEFT JOIN project_import_facts f ON f.project_id=e.project_id AND f.sha256=e.sha256 WHERE e.project_id=? AND e.generation=? AND e.kind<>'directory' AND NOT (e.kind='photo' AND COALESCE(f.excluded,0)=1) AND e.name >= ? ORDER BY e.name LIMIT 1`);
      let next = "";
      for (;;) {
        const entry = statement.get(id, h.generation, next) as Entry | null; if (!entry) break;
        next = entry.name + "\0";
        if (entry.kind === "photo" || entry.kind === "video") {
          if (!this.chosenEntry(id, h.generation, entry)) continue;
        }
        if (entry.kind === "mask") {
          const stem = entry.name.slice(0, -extname(entry.name).length - "_mask".length);
          const matches = this.db.query("SELECT name,kind,size,signature,sha256 FROM project_import_entries WHERE project_id=? AND generation=? AND kind='photo' AND name>=? AND name<?")
            .all(id, h.generation, stem + ".", stem + "/") as Entry[];
          const photos = matches.filter(photo => photo.name.slice(0, -extname(photo.name).length) === stem);
          if (photos.length && !photos.some(photo => this.chosenEntry(id, h.generation, photo))) continue;
        }
        try {
          await this.digest(h.path, entry);
          const path = await this.safePath(h.path, entry.name);
          const extension = extname(entry.name);
          const stem = entry.name.slice(0, -extension.length);
          const pairedStem = entry.kind === "mask" ? stem.slice(0, -"_mask".length) : stem;
          const taskName = createHash("sha256").update(pairedStem).digest("hex") + (entry.kind === "mask" ? "_mask" : "") + extension;
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let result: TaskApiResult<void>;
          try {
            const info = await file.stat({ bigint: true });
            if (!info.isFile() || signature(info) !== entry.signature) throw new ImportUnavailable("changed");
            result = await client.uploadImage(uuid, taskName, Bun.file(file.fd), signal);
            if (signature(await file.stat({ bigint: true })) !== entry.signature) throw new ImportUnavailable("changed");
          } finally { await file.close(); }
          await this.digest(h.path, entry);
          await this.assertReady(id);
          if (this.header(id)?.generation !== h.generation) throw new ImportUnavailable("changed");
          if (!result.ok) return result;
        } catch (error) { throw unavailable(error); }
      }
      await this.assertReady(id);
      if (this.header(id)?.generation !== h.generation) throw new ImportUnavailable("changed");
      return { ok: true, value: undefined };
    } finally { this.busy.delete(id); }
  }
}
