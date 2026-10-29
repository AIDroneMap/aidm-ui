import { errorResponse } from "../../shared/api-error.ts";
import { isLoopbackAddress } from "../auth/hook.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";

export function importRoutes(ctx: RouteContext): RouteTable {
  function projectId(raw: string): number | Response {
    if (!/^[1-9]\d{0,14}$/.test(raw)) return errorResponse(404, "project.not_found");
    const id = Number(raw);
    if (id === ctx.projects.sampleId()) return errorResponse(409, "project.sample_photos_forbidden");
    return ctx.projects.get(id) === null ? errorResponse(404, "project.not_found") : id;
  }
  return {
    "/api/projects/:id/import": {
      GET: async (req, rc) => {
        const id = projectId(req.params.id ?? "");
        if (id instanceof Response) return id;
        const query = new URL(req.url).searchParams;
        const offset = query.get("offset") ?? "0", limit = query.get("limit") ?? "50";
        if (!/^(0|[1-9]\d*)$/.test(offset) || !/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(offset)) || Number(limit) > 100) return errorResponse(400, "api.invalid_body");
        const release = ctx.projectDeletion.beginWrite(id);
        if (release === null) return errorResponse(409, "project.deletion_busy");
        try {
          const view = await ctx.imports.view(id, Number(offset), Number(limit));
          const available = isLoopbackAddress(rc.client.address);
          return Response.json({ ...view, available, path: available ? view.path : null });
        } finally { release(); }
      },
      PUT: async (req, rc) => {
        if (!isLoopbackAddress(rc.client.address)) return errorResponse(403, "import.local_only");
        const id = projectId(req.params.id ?? "");
        if (id instanceof Response) return id;
        const input = await readJson(req);
        if (!input.ok) return input.response;
        if (typeof input.body.path !== "string" || input.body.path.length === 0 || input.body.path.length > 32768 || input.body.path.includes("\0") || Object.keys(input.body).some(key => key !== "path")) return errorResponse(400, "api.invalid_body");
        const release = ctx.projectDeletion.beginWrite(id);
        if (release === null) return errorResponse(409, "project.deletion_busy");
        try {
          rc.server.timeout(req, 0);
          const result = await ctx.imports.select(id, input.body.path);
          if (result === "invalid_path") return errorResponse(400, "import.invalid_path");
          if (result === "unreadable") return errorResponse(400, "import.unreadable");
          if (result === "busy") return errorResponse(409, "import.busy");
          if (result === "uploads_present") return errorResponse(409, "import.uploads_present");
          return Response.json({ ...await ctx.imports.view(id, 0, 50), available: true });
        } finally { release(); }
      },
    },
  };
}
