import { errorResponse } from "../../shared/api-error.ts";
import { parseSettingsFile } from "../../shared/settings-file.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";
const id = (value: string | undefined) => typeof value === "string" && /^[1-9]\d{0,14}$/.test(value) ? Number(value) : null;

export function presetRoutes(ctx: RouteContext): RouteTable {
  return {
    "/api/presets": {
      GET: req => {
        const offset = new URL(req.url).searchParams.get("offset") ?? "0";
        return /^\d{1,9}$/.test(offset) ? Response.json(ctx.presets.list(Number(offset))) : errorResponse(400, "api.invalid_body");
      },
      POST: async req => {
        const body = await readJson(req); if (!body.ok) return body.response;
        const file = parseSettingsFile(body.body);
        if (!file) return errorResponse(400, "preset.invalid_file");
        const saved = ctx.presets.create(file);
        return saved ? Response.json(saved, { status: 201 }) : errorResponse(409, "preset.name_taken");
      },
    },
    "/api/presets/:id": {
      GET: req => {
        const key = id(req.params.id), saved = key === null ? null : ctx.presets.get(key);
        return saved ? Response.json(saved) : errorResponse(404, "preset.not_found");
      },
      PUT: async req => {
        const key = id(req.params.id); if (key === null) return errorResponse(404, "preset.not_found");
        const parsed = await readJson(req); if (!parsed.ok) return parsed.response;
        const name = parsed.body.preset;
        if (Object.keys(parsed.body).length !== 1 || typeof name !== "string" || !name.trim() || name.length > 200) return errorResponse(400, "preset.invalid_name");
        const result = ctx.presets.rename(key, name.trim());
        return result === "missing" ? errorResponse(404, "preset.not_found") : result === "name_taken" ? errorResponse(409, "preset.name_taken") : Response.json(result);
      },
      DELETE: req => {
        const key = id(req.params.id);
        return key !== null && ctx.presets.remove(key) ? new Response(null, { status: 204 }) : errorResponse(404, "preset.not_found");
      },
    },
  };
}
