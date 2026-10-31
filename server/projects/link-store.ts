import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

type LinkResult = { ok: true; size: number } | { ok: false; code: "link.invalid_url" | "link.unreachable" | "link.not_zip" | "link.unknown_size" };

function parseUrl(value: string): URL | null {
  if (value.length > 8192 || /[\x00-\x20\x7f#\\]/.test(value) || /^[a-z][a-z\d+.-]*:\/\/[^/]*@/i.test(value)) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) return null;
    return url;
  } catch { return null; }
}

function isZip(response: Response, url: URL): boolean {
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (mime === "application/zip" || mime === "application/x-zip-compressed") return true;
  if (mime && mime !== "application/octet-stream") return false;
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = /(?:^|;)\s*filename\s*=\s*(?:"([^"\r\n]*)"|([^;\s]*))/i.exec(disposition);
  return /\.zip$/i.test(filename?.[1] ?? filename?.[2] ?? "") || /\.zip$/i.test(url.pathname);
}

export class LinkStore {
  private readonly checking = new Set<number>();
  isBusy(id: number): boolean { return this.checking.has(id); }
  beginCheck(id: number): (() => void) | null {
    if (this.checking.has(id)) return null;
    this.checking.add(id);
    return () => { this.checking.delete(id); };
  }
  constructor(private readonly db: Database, private readonly request: typeof fetch = fetch) {}

  get(projectId: number): string | null {
    return (this.db.query("SELECT url FROM project_links WHERE project_id = ?").get(projectId) as { url: string } | null)?.url ?? null;
  }

  has(projectId: number): boolean { return this.get(projectId) !== null; }

  async select(projectId: number, value: string): Promise<LinkResult> {
    let url = parseUrl(value);
    if (!url) return { ok: false, code: "link.invalid_url" };
    let requestUrl = value;
    const signal = AbortSignal.timeout(10_000);
    let response: Response;
    try {
      for (let redirects = 0; ; redirects++) {
        response = await this.request(requestUrl, { method: "HEAD", redirect: "manual", signal });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location || redirects >= 5 || /[\x00-\x20\x7f#\\]/.test(location) || /^(?:[a-z][a-z\d+.-]*:)?\/\/[^/]*@/i.test(location)) return { ok: false, code: "link.unreachable" };
        const next = parseUrl(new URL(location, url).href);
        if (!next) return { ok: false, code: "link.unreachable" };
        url = next;
        requestUrl = next.href;
      }
    } catch { return { ok: false, code: "link.unreachable" }; }
    if (!response.ok) return { ok: false, code: "link.unreachable" };
    if (!isZip(response, url)) return { ok: false, code: "link.not_zip" };
    const length = response.headers.get("content-length");
    const size = length && /^\d+$/.test(length) ? Number(length) : NaN;
    if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, code: "link.unknown_size" };
    this.db.query("INSERT INTO project_links (project_id, url) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET url = excluded.url").run(projectId, value);
    this.db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), projectId);
    return { ok: true, size };
  }

  clear(projectId: number): void { this.db.query("DELETE FROM project_links WHERE project_id = ?").run(projectId); }

  revision(projectId: number): string {
    const url = this.get(projectId);
    return url === null ? "" : createHash("sha256").update(url).digest("hex");
  }

  recordRun(projectId: number, runId: number): void {
    const url = this.get(projectId);
    if (url) this.recordSource(projectId, runId, url);
  }

  recordSource(projectId: number, runId: number, url: string): void {
    const revision = createHash("sha256").update(url).digest("hex");
    if (!revision) return;
    this.db.query("INSERT INTO run_link_sources (run_id, source_hash) SELECT id, ? FROM runs WHERE id = ? AND project_id = ? ON CONFLICT(run_id) DO UPDATE SET source_hash = excluded.source_hash").run(revision, runId, projectId);
  }

  runIds(projectId: number): number[] {
    const revision = this.revision(projectId);
    if (!revision) return [];
    return (this.db.query("SELECT runs.id FROM runs JOIN run_link_sources ON run_link_sources.run_id = runs.id WHERE runs.project_id = ? AND run_link_sources.source_hash = ? ORDER BY runs.id DESC").all(projectId, revision) as { id: number }[]).map(row => row.id);
  }
}
