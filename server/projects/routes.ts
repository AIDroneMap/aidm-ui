import { errorResponse } from "../../shared/api-error.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";

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
