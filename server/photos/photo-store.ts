import type { ImportStore } from "../projects/import-store.ts";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { ProjectPhotoFactsView } from "../../shared/api-types.ts";
import { captureMoment, detectFlights, type FlightPhoto } from "./flights.ts";
import { readPhotoMetadata, type PhotoMetadata } from "./metadata.ts";

interface PhotoRow {
  sha256: string;
  size: number;
  storageId: string;
  name: string;
  readerKind: string | null;
  facts: string | null;
  excluded: number;
}

/** Caches bounded metadata reads. Images and pixel data never enter a response. */
export class PhotoStore {
  private readonly preparing = new Map<number, Promise<void>>();
  constructor(private readonly db: Database, private readonly folder: string, private readonly imports?: ImportStore) {}

  private rows(projectId: number): PhotoRow[] {
    if (this.imports?.has(projectId)) return this.imports.photoRows(projectId).map(row => ({ ...row, storageId: "" }));
    return this.db.query(`SELECT f.sha256, f.size, f.storage_id AS storageId,
      (SELECT a.name FROM project_upload_aliases a WHERE a.project_id = f.project_id AND a.sha256 = f.sha256 AND a.kind = 'photo'
       ORDER BY CASE WHEN lower(a.name) GLOB '*.raw' OR lower(a.name) GLOB '*.bmp' THEN 1 ELSE 0 END, a.name LIMIT 1) AS name,
      m.reader_kind AS readerKind, m.facts,
      CASE WHEN e.sha256 IS NULL THEN 0 ELSE 1 END AS excluded
      FROM project_upload_files f
      LEFT JOIN project_photo_metadata m ON m.project_id = f.project_id AND m.sha256 = f.sha256
      LEFT JOIN project_photo_exclusions e ON e.project_id = f.project_id AND e.sha256 = f.sha256
      WHERE f.project_id = ? AND EXISTS (SELECT 1 FROM project_upload_aliases a WHERE a.project_id = f.project_id AND a.sha256 = f.sha256 AND a.kind = 'photo')
      ORDER BY f.sha256`).all(projectId) as PhotoRow[];
  }

  private kind(name: string): string { return /\.(raw|bmp)$/i.test(name) ? "unsupported" : "container"; }

  private async prepare(projectId: number): Promise<void> {
    if (this.imports?.has(projectId)) { await this.imports.prepareMetadata(projectId); return; }
    const existing = this.preparing.get(projectId);
    if (existing !== undefined) return existing;
    const pending = this.rows(projectId).filter(row => row.facts === null || row.readerKind !== this.kind(row.name)).slice(0, 32);
    const task = (async () => {
      for (const row of pending) {
        const facts = await readPhotoMetadata(join(this.folder, "projects", String(projectId), "files", row.storageId), row.name);
        this.db.query("INSERT INTO project_photo_metadata (project_id, sha256, reader_kind, facts) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, sha256) DO UPDATE SET reader_kind = excluded.reader_kind, facts = excluded.facts")
          .run(projectId, row.sha256, this.kind(row.name), JSON.stringify(facts));
      }
    })();
    this.preparing.set(projectId, task);
    try { await task; } finally { this.preparing.delete(projectId); }
  }

  private flights(rows: PhotoRow[]) {
    const photos: FlightPhoto[] = rows.map(row => {
      const metadata = row.facts === null ? null : JSON.parse(row.facts) as PhotoMetadata;
      return { sha256: row.sha256, captureTime: metadata?.captureTime ?? null, make: metadata?.make ?? null, model: metadata?.model ?? null, excluded: row.excluded === 1 };
    });
    return detectFlights(photos);
  }

  async setFlightExcluded(projectId: number, flightId: string, excluded: boolean): Promise<"ok" | "not_found" | "busy"> {
    if (this.imports?.isBusy(projectId)) return "busy";
    await this.prepare(projectId);
    if (this.imports?.isBusy(projectId)) return "busy";
    const rows = this.rows(projectId);
    if (rows.some(row => row.facts === null || row.readerKind !== this.kind(row.name))) return "busy";
    const flight = this.flights(rows).flights.find(flight => flight.id === flightId);
    if (flight === undefined) return "not_found";
    if (this.imports?.has(projectId)) {
      this.imports.setExcluded(projectId, flight.checksums, excluded);
      return "ok";
    }
    this.db.transaction(() => {
      for (const sha256 of flight.checksums) {
        if (excluded) this.db.query("INSERT OR IGNORE INTO project_photo_exclusions (project_id, sha256) VALUES (?, ?)").run(projectId, sha256);
        else this.db.query("DELETE FROM project_photo_exclusions WHERE project_id = ? AND sha256 = ?").run(projectId, sha256);
      }
      this.db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), projectId);
    })();
    return "ok";
  }

  async facts(projectId: number, offset: number, limit: number): Promise<ProjectPhotoFactsView> {
    await this.prepare(projectId);
    const rows = this.rows(projectId);
    const counts = this.imports?.has(projectId) ? this.imports.counts(projectId) : this.db.query("SELECT SUM(CASE WHEN kind = 'photo' THEN 1 ELSE 0 END) AS photoAliases, COUNT(DISTINCT CASE WHEN kind = 'video' THEN sha256 END) AS videoCount FROM project_upload_aliases WHERE project_id = ?").get(projectId) as { photoAliases: number | null; videoCount: number };
    const metadata = rows.filter(row => row.facts !== null).map(row => JSON.parse(row.facts!) as PhotoMetadata);
    const cameras = new Map<string, ProjectPhotoFactsView["cameras"][number]>();
    const bands = new Map<string, number>();
    const spans = new Map<string, Array<{ value: string; time: number }>>();
    for (const facts of metadata) {
      if (facts.band !== null) bands.set(facts.band, (bands.get(facts.band) ?? 0) + 1);
      if (facts.make !== null || facts.model !== null) {
        const key = JSON.stringify([facts.make, facts.model]);
        const camera = cameras.get(key) ?? { make: facts.make, model: facts.model, photoCount: 0 };
        camera.photoCount++;
        cameras.set(key, camera);
      }
      const moment = captureMoment(facts.captureTime);
      if (facts.captureTime !== null && Number.isFinite(moment.time)) {
        const group = spans.get(moment.clock) ?? [];
        group.push({ value: facts.captureTime, time: moment.time });
        spans.set(moment.clock, group);
      }
    }
    const dateSpans: ProjectPhotoFactsView["dateSpans"] = [];
    for (const clock of ["camera", "offset"] as const) {
      const group = spans.get(clock);
      if (group === undefined) continue;
      group.sort((a, b) => a.time - b.time || a.value.localeCompare(b.value));
      dateSpans.push({ clock, first: group[0]!.value, last: group[group.length - 1]!.value });
    }
    const detected = this.flights(rows);
    return {
      photoCount: rows.length, photoBytes: rows.reduce((sum, row) => sum + row.size, 0),
      duplicates: (counts.photoAliases ?? 0) - rows.length, videoCount: counts.videoCount,
      withoutGps: metadata.filter(facts => facts.latitude === null || facts.longitude === null).length,
      cameras: [...cameras.values()].sort((a, b) => JSON.stringify([a.make, a.model]).localeCompare(JSON.stringify([b.make, b.model]))),
      bands: [...bands.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, photoCount]) => ({ name, photoCount })), dateSpans,
      flights: detected.flights.slice(offset, offset + limit).map(({ checksums, ...flight }) => flight),
      flightCount: detected.flights.length, unassignedCount: detected.unassignedCount,
      pendingMetadata: rows.filter(row => row.facts === null || row.readerKind !== this.kind(row.name)).length,
      nextOffset: offset + limit < detected.flights.length ? offset + limit : null,
    };
  }
}
