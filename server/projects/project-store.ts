import { RUN_STATES, type ProjectView } from "../../shared/api-types.ts";
import type { Database } from "bun:sqlite";
import { SAMPLE_DATASET } from "../sample/sample-dataset.ts";

export type Project = ProjectView;

export class ProjectStore {
  constructor(private readonly db: Database, private readonly sampleCount = SAMPLE_DATASET.imageCount) {}

  list(): Project[] {
    const rows = this.db.query(`SELECT p.id, p.name, p.notes, p.builtin,
      CASE WHEN EXISTS (SELECT 1 FROM project_links l WHERE l.project_id = p.id) THEN NULL ELSE p.photo_count END AS photoCount,
      (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id) AS runCount,
      (SELECT state FROM runs r WHERE r.project_id = p.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS latestState,
      MAX(p.updated_at, COALESCE((SELECT MAX(updated_at) FROM runs r WHERE r.project_id = p.id), p.updated_at)) AS lastChange
      FROM projects p WHERE p.builtin IS NULL OR EXISTS (SELECT 1 FROM runs r WHERE r.project_id = p.id)
      ORDER BY lastChange DESC, p.id DESC`).all() as Project[];
    return rows.map((row) => ({
      ...row,
      ...this.resultSizes(row.id),
      photoCount: row.builtin === "sample" ? this.sampleCount : row.photoCount,
      latestState: row.latestState === null || (RUN_STATES as readonly string[]).includes(row.latestState) ? row.latestState : "unknown",
    }));
  }

  private resultSizes(projectId: number): Pick<ProjectView, "resultsBytes" | "resultArchives"> {
    const rows = this.db.query(`SELECT r.id AS runId, CAST(json_extract(a.details, '$.archiveSize') AS INTEGER) AS size
      FROM runs r JOIN run_results a ON a.run_id = r.id
      WHERE r.project_id = ? AND json_extract(a.details, '$.state') = 'ready' ORDER BY r.id`).all(projectId) as Array<{ runId: number; size: number }>;
    return { resultsBytes: rows.reduce((sum, row) => sum + row.size, 0), resultArchives: rows };
  }

  sampleId(): number | null {
    const row = this.db.query("SELECT id FROM projects WHERE builtin = 'sample'").get() as { id: number } | null;
    return row?.id ?? null;
  }

  get(id: number): Project | null {
    return this.list().find((project) => project.id === id) ?? null;
  }

  update(id: number, name: string, notes: string): Project | null {
    this.db.query("UPDATE projects SET name = CASE WHEN builtin IS NULL THEN ? ELSE name END, notes = ?, updated_at = ? WHERE id = ?")
      .run(name, notes, new Date().toISOString(), id);
    return this.get(id);
  }

  setPhotoCount(id: number, count: number): { ok: true } | { ok: false; code: "project.sample_photos_forbidden" | "project.not_found" } {
    const row = this.db.query("SELECT builtin FROM projects WHERE id = ?").get(id) as { builtin: string | null } | null;
    if (row === null) return { ok: false, code: "project.not_found" };
    if (row.builtin !== null) return { ok: false, code: "project.sample_photos_forbidden" };
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Invalid photo count");
    this.db.query("UPDATE projects SET photo_count = ?, updated_at = ? WHERE id = ?").run(count, new Date().toISOString(), id);
    return { ok: true };
  }

  runs(id: number): Array<{ id: number; engineId: number | null; taskUuid: string | null; state: string }> {
    return this.db.query("SELECT id, engine_id AS engineId, task_uuid AS taskUuid, state FROM runs WHERE project_id = ? ORDER BY id").all(id) as Array<{ id: number; engineId: number | null; taskUuid: string | null; state: string }>;
  }

  removeRows(id: number): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM runs WHERE project_id = ?").run(id);
      this.db.query("DELETE FROM projects WHERE id = ? AND builtin IS NULL").run(id);
    })();
  }

  create(name: string, notes: string): Project {
    const now = new Date().toISOString();
    const row = this.db.query("INSERT INTO projects (name, notes, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id").get(name, notes, now, now) as { id: number };
    return this.list().find((project) => project.id === row.id)!;
  }
}
