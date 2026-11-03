import { errorResponse } from "../../shared/api-error.ts";
import { isLoopbackAddress } from "../auth/hook.ts";
import { ImportUnavailable } from "../projects/import-store.ts";
import type { RouteContext, RouteTable } from "../http/route-table.ts";

export function photoRoutes(ctx: RouteContext): RouteTable {
  return {
    "/api/projects/:id/photo-positions": {
      GET: async (req, rc) => {
        if (!/^[1-9]\d{0,14}$/.test(req.params.id ?? "")) return errorResponse(404, "project.not_found");
        const id = Number(req.params.id);
        if (id === ctx.projects.sampleId()) return errorResponse(409, "project.sample_photos_forbidden");
        if (ctx.projects.get(id) === null) return errorResponse(404, "project.not_found");
        const query = new URL(req.url).searchParams;
        const offset = query.get("offset") ?? "0", limit = query.get("limit") ?? "100";
        if (!/^(0|[1-9]\d*)$/.test(offset) || !/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(offset)) || Number(limit) > 100) return errorResponse(400, "api.invalid_body");
        const release = ctx.projectDeletion.beginWrite(id);
        if (release === null) return errorResponse(409, "project.deletion_busy");
        try {
          if (ctx.imports.isBusy(id)) return errorResponse(409, "import.busy");
          const view = await ctx.photos.positions(id, Number(offset), Number(limit));
          return Response.json({ ...view, localImportAllowed: isLoopbackAddress(rc.client.address) });
        } catch (error) {
          if (error instanceof ImportUnavailable) return errorResponse(409, error.state === "missing" ? "import.missing" : "import.changed");
          throw error;
        } finally { release(); }
      },
    },
    "/api/projects/:id/photos/:sha256/thumbnail": {
      GET: async req => {
        if (!/^[1-9]\d{0,14}$/.test(req.params.id ?? "")) return errorResponse(404, "project.not_found");
        const id = Number(req.params.id);
        if (id === ctx.projects.sampleId()) return errorResponse(409, "project.sample_photos_forbidden");
        if (ctx.projects.get(id) === null) return errorResponse(404, "project.not_found");
        const sha256 = req.params.sha256 ?? "";
        if (!/^[0-9a-f]{64}$/.test(sha256)) return errorResponse(404, "api.not_found");
        const release = ctx.projectDeletion.beginWrite(id);
        if (release === null) return errorResponse(409, "project.deletion_busy");
        try {
          if (ctx.imports.isBusy(id)) return errorResponse(409, "import.busy");
          const bytes = await ctx.photos.thumbnail(id, sha256);
          if (bytes === null) return errorResponse(404, "api.not_found");
          return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400, immutable" } });
        } catch (error) {
          if (error instanceof ImportUnavailable) return errorResponse(409, error.state === "missing" ? "import.missing" : "import.changed");
          throw error;
        } finally { release(); }
      },
    },
  };
}
