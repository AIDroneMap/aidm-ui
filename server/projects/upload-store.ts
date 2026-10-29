import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { UploadRequest, UploadSessionView, UploadedFilesView } from "../../shared/api-types.ts";
import { classifyUploadFile } from "../../shared/upload-files.ts";

export const UPLOAD_CHUNK_SIZE = 1024 * 1024;

export class UploadStore {
  private readonly busy = new Set<string>();
  constructor(private readonly db: Database, private readonly folder: string) {}

  create(projectId: number, input: UploadRequest): UploadSessionView {
    const existing = this.db.query("SELECT id FROM project_uploads WHERE project_id = ? AND name = ? AND size = ? AND sha256 = ?").get(projectId, input.name, input.size, input.sha256) as { id: string } | null;
    if (existing !== null) return this.get(projectId, existing.id)!;
    const id = randomBytes(16).toString("hex");
    this.db.transaction(() => {
      const content = this.db.query("SELECT size FROM project_upload_files WHERE project_id = ? AND sha256 = ?").get(projectId, input.sha256) as { size: number } | null;
      const complete = content !== null && content.size === input.size;
      this.db.query("INSERT INTO project_uploads (id, project_id, name, size, sha256, chunk_size, complete) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, projectId, input.name, input.size, input.sha256, UPLOAD_CHUNK_SIZE, complete ? 1 : 0);
      if (complete) this.addAlias(projectId, input.name, input.sha256);
    })();
    return this.get(projectId, id)!;
  }

  private addAlias(projectId: number, name: string, sha256: string): void {
    const kind = classifyUploadFile(name);
    this.db.query("INSERT OR IGNORE INTO project_upload_aliases (project_id, name, sha256, kind) VALUES (?, ?, ?, ?)").run(projectId, name, sha256, kind);
    this.db.query("UPDATE projects SET photo_count = (SELECT COUNT(DISTINCT sha256) FROM project_upload_aliases WHERE project_id = ? AND kind = 'photo'), updated_at = ? WHERE id = ?").run(projectId, new Date().toISOString(), projectId);
  }

  list(projectId: number, offset: number, limit: number): UploadedFilesView {
    const files = this.db.query("SELECT a.name, f.size, a.sha256, a.kind FROM project_upload_aliases a JOIN project_upload_files f ON f.project_id = a.project_id AND f.sha256 = a.sha256 WHERE a.project_id = ? ORDER BY a.name, a.sha256 LIMIT ? OFFSET ?").all(projectId, limit + 1, offset) as UploadedFilesView["files"];
    return { files: files.slice(0, limit), nextOffset: files.length > limit ? offset + limit : null };
  }

  async cancel(projectId: number, id: string): Promise<"ok" | "not_found" | "busy" | "complete"> {
    const session = this.get(projectId, id);
    if (session === null) return "not_found";
    if (this.busy.has(id)) return "busy";
    if (session.complete) return "complete";
    this.busy.add(id);
    try {
      await rm(join(this.folder, "projects", String(projectId), "uploads", id), { recursive: true, force: true });
      this.db.query("DELETE FROM project_uploads WHERE project_id = ? AND id = ?").run(projectId, id);
      return "ok";
    } finally { this.busy.delete(id); }
  }

  async complete(projectId: number, id: string): Promise<"ok" | "not_found" | "incomplete" | "checksum" | "busy"> {
    const row = this.db.query("SELECT name, size, sha256, chunk_size AS chunkSize, complete FROM project_uploads WHERE project_id = ? AND id = ?").get(projectId, id) as { name: string; size: number; sha256: string; chunkSize: number; complete: number } | null;
    if (row === null) return "not_found";
    if (this.busy.has(id)) return "busy";
    if (row.complete) return "ok";
    const chunks = this.db.query("SELECT chunk_index AS idx, sha256 FROM project_upload_chunks WHERE upload_id = ? ORDER BY chunk_index").all(id) as { idx: number; sha256: string }[];
    const count = Math.ceil(row.size / row.chunkSize);
    if (chunks.length !== count || chunks.some((chunk, index) => chunk.idx !== index)) return "incomplete";
    this.busy.add(id);
    const root = join(this.folder, "projects", String(projectId));
    const directory = join(root, "uploads", id);
    const files = join(root, "files");
    const storageId = randomBytes(16).toString("hex");
    const temporary = join(directory, `${storageId}.tmp`);
    let published = false;
    try {
      await mkdir(files, { recursive: true });
      const output = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let total = 0;
      try {
        for (const chunk of chunks) {
          const chunkHash = createHash("sha256");
          let chunkSize = 0;
          try {
            for await (const bytes of createReadStream(join(directory, String(chunk.idx)))) {
              const data = bytes as Buffer;
              total += data.length;
              chunkSize += data.length;
              if (chunkSize > Math.min(row.chunkSize, row.size - chunk.idx * row.chunkSize)) break;
              hash.update(data);
              chunkHash.update(data);
              let offset = 0;
              while (offset < data.length) offset += (await output.write(data, offset, data.length - offset)).bytesWritten;
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (chunkSize !== Math.min(row.chunkSize, row.size - chunk.idx * row.chunkSize) || chunkHash.digest("hex") !== chunk.sha256) {
            this.db.query("DELETE FROM project_upload_chunks WHERE upload_id = ? AND chunk_index = ?").run(id, chunk.idx);
            return "checksum";
          }
        }
      } finally { await output.close(); }
      if (total !== row.size || hash.digest("hex") !== row.sha256) return "checksum";
      await rename(temporary, join(files, storageId));
      const inserted = this.db.transaction(() => {
        const result = this.db.query("INSERT OR IGNORE INTO project_upload_files (project_id, sha256, size, storage_id) VALUES (?, ?, ?, ?)").run(projectId, row.sha256, row.size, storageId);
        this.addAlias(projectId, row.name, row.sha256);
        this.db.query("UPDATE project_uploads SET complete = 1 WHERE id = ? AND project_id = ?").run(id, projectId);
        return result.changes > 0;
      })();
      published = inserted;
      if (!inserted) await rm(join(files, storageId), { force: true });
      await rm(directory, { recursive: true, force: true });
      this.db.query("DELETE FROM project_upload_chunks WHERE upload_id = ?").run(id);
      return "ok";
    } finally {
      await rm(temporary, { force: true });
      if (!published) await rm(join(files, storageId), { force: true });
      this.busy.delete(id);
    }
  }

  get(projectId: number, id: string): UploadSessionView | null {
    const row = this.db.query("SELECT id, chunk_size AS chunkSize, complete FROM project_uploads WHERE project_id = ? AND id = ?").get(projectId, id) as { id: string; chunkSize: number; complete: number } | null;
    if (row === null) return null;
    const chunks = this.db.query("SELECT chunk_index AS idx FROM project_upload_chunks WHERE upload_id = ? ORDER BY chunk_index").all(id) as { idx: number }[];
    return { id: row.id, chunkSize: row.chunkSize, received: chunks.map(chunk => chunk.idx), complete: row.complete === 1 };
  }

  async resume(projectId: number, id: string): Promise<UploadSessionView | "busy" | null> {
    const session = this.get(projectId, id);
    if (session === null) return null;
    if (this.busy.has(id)) return "busy";
    if (session.complete) return session;
    const row = this.db.query("SELECT size, chunk_size AS chunkSize FROM project_uploads WHERE id = ? AND project_id = ?").get(id, projectId) as { size: number; chunkSize: number };
    const chunks = this.db.query("SELECT chunk_index AS idx, sha256 FROM project_upload_chunks WHERE upload_id = ? ORDER BY chunk_index").all(id) as { idx: number; sha256: string }[];
    this.busy.add(id);
    try {
      for (const chunk of chunks) {
        let size = 0;
        const hash = createHash("sha256");
        const expected = Math.min(row.chunkSize, row.size - chunk.idx * row.chunkSize);
        try {
          for await (const bytes of createReadStream(join(this.folder, "projects", String(projectId), "uploads", id, String(chunk.idx)))) {
            const data = bytes as Buffer;
            size += data.length;
            if (size > expected) break;
            hash.update(data);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (size !== expected || hash.digest("hex") !== chunk.sha256) this.db.query("DELETE FROM project_upload_chunks WHERE upload_id = ? AND chunk_index = ?").run(id, chunk.idx);
      }
      return this.get(projectId, id);
    } finally { this.busy.delete(id); }
  }

  async chunk(projectId: number, id: string, index: number, checksum: string, body: ReadableStream<Uint8Array> | null): Promise<"ok" | "not_found" | "invalid" | "checksum" | "busy"> {
    const row = this.db.query("SELECT size, chunk_size AS chunkSize, complete FROM project_uploads WHERE project_id = ? AND id = ?").get(projectId, id) as { size: number; chunkSize: number; complete: number } | null;
    if (row === null) return "not_found";
    if (this.busy.has(id)) return "busy";
    if (row.complete || !Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(row.size / row.chunkSize) || !/^[a-f0-9]{64}$/.test(checksum)) return "invalid";
    this.busy.add(id);
    const directory = join(this.folder, "projects", String(projectId), "uploads", id);
    const temporary = join(directory, `${index}.${randomBytes(16).toString("hex")}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      const file = await open(temporary, "wx", 0o600);
      let size = 0;
      const hash = createHash("sha256");
      const expected = Math.min(row.chunkSize, row.size - index * row.chunkSize);
      try {
        if (body !== null) for await (const bytes of body) {
          size += bytes.byteLength;
          if (size > expected) return "invalid";
          hash.update(bytes);
          let offset = 0;
          while (offset < bytes.byteLength) offset += (await file.write(bytes, offset, bytes.byteLength - offset)).bytesWritten;
        }
      } finally { await file.close(); }
      if (size !== expected) return "invalid";
      if (hash.digest("hex") !== checksum) return "checksum";
      await rename(temporary, join(directory, String(index)));
      this.db.query("INSERT INTO project_upload_chunks (upload_id, chunk_index, sha256) VALUES (?, ?, ?) ON CONFLICT (upload_id, chunk_index) DO UPDATE SET sha256 = excluded.sha256").run(id, index, checksum);
      return "ok";
    } finally {
      await rm(temporary, { force: true });
      this.busy.delete(id);
    }
  }
}
