import { errorResponse } from "../../shared/api-error.ts";
import { readJson, withBodyLimit, type RouteContext, type RouteTable } from "../http/route-table.ts";
import { classifyUploadFile } from "../../shared/upload-files.ts";
import { UPLOAD_CHUNK_SIZE } from "./upload-store.ts";

function idOf(raw: string): number | null {
  if (!/^[1-9]\d{0,14}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

export function projectRoutes(ctx: RouteContext): RouteTable {
  async function fields(req: Request): Promise<{ name: string; notes: string } | Response> {
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.response;
    const { name, notes } = parsed.body;
    if (typeof name !== "string" || typeof notes !== "string" || notes.length > 100_000) return errorResponse(400, "api.invalid_body");
    if (name.trim() === "" || name.trim().length > 200) return errorResponse(400, "project.name_required");
    return { name: name.trim(), notes };
  }
  return {
    "/api/projects/:id/uploads": {
      POST: async req => {
        const id = idOf(req.params.id ?? "");
        if (id === ctx.projects.sampleId()) return errorResponse(409, "project.sample_photos_forbidden");
        if (id === null || ctx.projects.get(id) === null) return errorResponse(404, "project.not_found");
        const release = ctx.projectDeletion.beginWrite(id);
        if (release === null) return errorResponse(409, "project.deletion_busy");
        try {
          const parsed = await readJson(req);
          if (!parsed.ok) return parsed.response;
          const { name, size, sha256 } = parsed.body;
          if (typeof name !== "string" || name.length < 1 || name.length > 4096 || /[\u0000-\u001f\\]/.test(name) || name.split("/").some(part => part === "" || part === "." || part === "..") || /^[a-z]:/i.test(name) || !Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > UPLOAD_CHUNK_SIZE * 1_000_000 || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) return errorResponse(400, "api.invalid_body");
          const kind = classifyUploadFile(name);
          if (kind === "ground_control") return errorResponse(400, "upload.ground_control_unsupported");
          if (kind === "unsupported") return errorResponse(400, "api.invalid_body");
          const created = ctx.uploads.create(id, { name, size: size as number, sha256 });
          const session = await ctx.uploads.resume(id, created.id);
          if (session === "busy") return errorResponse(409, "project.deletion_busy");
          return Response.json(session, { status: 201 });
        } finally { release(); }
      },
    },
    "/api/projects/:id/uploads/:uploadId/chunks/:index": {
      PUT: withBodyLimit(UPLOAD_CHUNK_SIZE, async (req, rc) => {
        const id = idOf(req.params.id ?? "");
        if (id === ctx.projects.sampleId()) return errorResponse(409, "project.sample_photos_forbidden");
        if (id === null) return errorResponse(404, "api.not_found");
        const release = ctx.projectDeletion.beginWrite(id);
        if (release === null) return errorResponse(409, "project.deletion_busy");
        try {
          const rawIndex = req.params.index ?? "";
          if (!/^(0|[1-9]\d*)$/.test(rawIndex)) return errorResponse(400, "api.invalid_body");
          rc.server.timeout(req, 0);
          const result = await ctx.uploads.chunk(id, req.params.uploadId ?? "", Number(rawIndex), req.headers.get("x-chunk-sha256") ?? "", req.body);
          if (result === "not_found") return errorResponse(404, "api.not_found");
          if (result === "busy") return errorResponse(409, "project.deletion_busy");
          if (result === "checksum") return errorResponse(400, "upload.checksum_mismatch");
          if (result === "invalid") return errorResponse(400, "api.invalid_body");
          return new Response(null, { status: 204 });
        } finally { release(); }
      }),
    },
    "/api/projects/:id/uploads/:uploadId/complete": {
      POST: async (req, rc) => {
        const id = idOf(req.params.id ?? "");
        if (id === ctx.projects.sampleId()) return errorResponse(409, "project.sample_photos_forbidden");
        if (id === null) return errorResponse(404, "api.not_found");
        const release = ctx.projectDeletion.beginWrite(id);
        if (release === null) return errorResponse(409, "project.deletion_busy");
        try {
          rc.server.timeout(req, 0);
          const result = await ctx.uploads.complete(id, req.params.uploadId ?? "");
          if (result === "not_found") return errorResponse(404, "api.not_found");
          if (result === "busy") return errorResponse(409, "project.deletion_busy");
          if (result === "incomplete") return errorResponse(409, "upload.incomplete");
          if (result === "checksum") return errorResponse(400, "upload.checksum_mismatch");
          return Response.json(ctx.uploads.get(id, req.params.uploadId ?? ""));
        } finally { release(); }
      },
    },
    "/api/projects/:id/photos": {
      GET: req => {
        const id = idOf(req.params.id ?? "");
        if (id === ctx.projects.sampleId()) return errorResponse(409, "project.sample_photos_forbidden");
        if (id === null || ctx.projects.get(id) === null) return errorResponse(404, "project.not_found");
        const query = new URL(req.url).searchParams;
        const offset = query.get("offset") ?? "0";
        const limit = query.get("limit") ?? "100";
        if (!/^(0|[1-9]\d*)$/.test(offset) || !/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(offset)) || Number(limit) > 100) return errorResponse(400, "api.invalid_body");
        return Response.json(ctx.uploads.list(id, Number(offset), Number(limit)));
      },
    },
    "/api/projects/:id/uploads/:uploadId": {
      GET: async req => {
        const id = idOf(req.params.id ?? "");
        if (id === ctx.projects.sampleId()) return errorResponse(409, "project.sample_photos_forbidden");
        if (id === null) return errorResponse(404, "api.not_found");
        const release = ctx.projectDeletion.beginWrite(id);
        if (release === null) return errorResponse(409, "project.deletion_busy");
        try {
          const session = await ctx.uploads.resume(id, req.params.uploadId ?? "");
          if (session === "busy") return errorResponse(409, "project.deletion_busy");
          return session === null ? errorResponse(404, "api.not_found") : Response.json(session);
        } finally { release(); }
      },
      DELETE: async req => {
        const id = idOf(req.params.id ?? "");
        if (id === ctx.projects.sampleId()) return errorResponse(409, "project.sample_photos_forbidden");
        if (id === null) return errorResponse(404, "api.not_found");
        const release = ctx.projectDeletion.beginWrite(id);
        if (release === null) return errorResponse(409, "project.deletion_busy");
        try {
          const result = await ctx.uploads.cancel(id, req.params.uploadId ?? "");
          if (result === "not_found") return errorResponse(404, "api.not_found");
          if (result !== "ok") return errorResponse(409, "project.deletion_busy");
          return new Response(null, { status: 204 });
        } finally { release(); }
      },
    },
    "/api/projects": {
      GET: () => Response.json(ctx.projects.list()),
      POST: async req => {
        const input = await fields(req);
        return input instanceof Response ? input : Response.json(ctx.projects.create(input.name, input.notes), { status: 201 });
      },
    },
    "/api/projects/:id": {
      GET: req => {
        const id = idOf(req.params.id ?? "");
        const project = id === null ? null : ctx.projects.get(id);
        return project === null ? errorResponse(404, "project.not_found") : Response.json(project);
      },
      PUT: async req => {
        const id = idOf(req.params.id ?? "");
        if (id === null || ctx.projects.get(id) === null) return errorResponse(404, "project.not_found");
        const input = await fields(req);
        if (input instanceof Response) return input;
        if (ctx.projectDeletion.isDeleting(id)) return errorResponse(409, "project.deletion_busy");
        const project = ctx.projects.update(id, input.name, input.notes);
        return project === null ? errorResponse(404, "project.not_found") : Response.json(project);
      },
      DELETE: async req => {
        const id = idOf(req.params.id ?? "");
        if (id === null) return errorResponse(404, "project.not_found");
        const result = await ctx.projectDeletion.delete(id);
        if (result === "not_found") return errorResponse(404, "project.not_found");
        if (result === "busy") return errorResponse(409, "project.deletion_busy");
        if (result === "engine_missing") return errorResponse(409, "project.deletion_engine_missing");
        if (result === "incomplete") return errorResponse(502, "project.deletion_incomplete");
        return new Response(null, { status: 204 });
      },
    },
  };
}
