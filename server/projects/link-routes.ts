import { errorResponse } from "../../shared/api-error.ts";
import type { LinkSourceView, LinkedPhotoFacts } from "../../shared/link-source.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";
import { readLinkedPhotoFacts } from "../photos/linked-facts.ts";

export function linkRoutes(ctx: RouteContext): RouteTable {
  const cache = new Map<number, { key: string; facts: Promise<LinkedPhotoFacts | null> }>();
  function projectId(raw: string): number | Response {
    if (!/^[1-9]\d{0,14}$/.test(raw)) return errorResponse(404, "project.not_found");
    const id = Number(raw);
    if (id === ctx.projects.sampleId()) return errorResponse(409, "project.sample_photos_forbidden");
    return ctx.projects.get(id) === null ? errorResponse(404, "project.not_found") : id;
  }
  async function view(id: number, size: number | null = null): Promise<LinkSourceView> {
    const url = ctx.links.get(id);
    if (url !== null) for (const runId of ctx.links.runIds(id)) {
      const run = ctx.tracker.record(runId);
      const entries = ctx.tracker.results.indexedEntries(runId);
      if (!run || !entries) { cache.delete(runId); continue; }
      const key = JSON.stringify(entries.find(entry => entry.name === "images.json") ?? null);
      let saved = cache.get(runId);
      if (!saved || saved.key !== key) {
        if (cache.size >= 32) cache.delete(cache.keys().next().value!);
        saved = { key, facts: readLinkedPhotoFacts(ctx.tracker.results.path(run), entries) };
        cache.set(runId, saved);
      }
      return { url, size, facts: await saved.facts, factsRunId: runId };
    }
    return { url, size, facts: null, factsRunId: null };
  }
  function busy(id: number): boolean {
    return ctx.links.isBusy(id) || ctx.imports.isBusy(id) || ctx.projects.runs(id).some(run => ["created", "uploading", "queued", "processing", "unknown"].includes(run.state));
  }
  return {
    "/api/projects/:id/link": {
      GET: async req => {
        const id = projectId(req.params.id ?? "");
        if (id instanceof Response) return id;
        const release = ctx.projectDeletion.beginWrite(id);
        if (!release) return errorResponse(409, "project.deletion_busy");
        try { return Response.json(await view(id)); } finally { release(); }
      },
      PUT: async req => {
        const id = projectId(req.params.id ?? "");
        if (id instanceof Response) return id;
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        if (typeof parsed.body.url !== "string" || Object.keys(parsed.body).some(key => key !== "url")) return errorResponse(400, "api.invalid_body");
        if (busy(id)) return errorResponse(409, "link.busy");
        if (ctx.imports.has(id) || ctx.uploads.hasSource(id)) return errorResponse(409, "link.source_present");
        const release = ctx.projectDeletion.beginWrite(id);
        if (!release) return errorResponse(409, "project.deletion_busy");
        const checked = ctx.links.beginCheck(id)!;
        try {
          const result = await ctx.links.select(id, parsed.body.url);
          return result.ok ? Response.json(await view(id, result.size)) : errorResponse(400, result.code);
        } finally { checked(); release(); }
      },
      DELETE: async req => {
        const id = projectId(req.params.id ?? "");
        if (id instanceof Response) return id;
        if (busy(id)) return errorResponse(409, "link.busy");
        const release = ctx.projectDeletion.beginWrite(id);
        if (!release) return errorResponse(409, "project.deletion_busy");
        try { ctx.links.clear(id); return Response.json(await view(id)); } finally { release(); }
      },
    },
  };
}
