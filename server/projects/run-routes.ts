import { errorResponse } from "../../shared/api-error.ts";
import { PRESET_IDS, type OptionValue, type PresetId } from "../../shared/option-catalogue.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";

function id(raw: unknown): number | null {
  const value = typeof raw === "number" ? String(raw) : raw;
  return typeof value === "string" && /^[1-9]\d{0,14}$/.test(value) ? Number(value) : null;
}
function preset(raw: unknown): raw is PresetId { return (PRESET_IDS as readonly unknown[]).includes(raw); }

function named(raw: unknown): raw is string | undefined { return raw === undefined || typeof raw === "string" && raw.trim().length > 0 && raw.length <= 200; }

function edits(raw: unknown): raw is Array<{ name: string; value: OptionValue }> | undefined {
  return raw === undefined || Array.isArray(raw) && raw.length <= 256 && raw.every(item =>
    item && typeof item === "object" && typeof item.name === "string" && item.name.length > 0 && item.name.length <= 200 &&
    Object.keys(item).every(key => key === "name" || key === "value") &&
    (typeof item.value === "string" || typeof item.value === "boolean" || typeof item.value === "number" && Number.isFinite(item.value)));
}

export function projectRunRoutes(ctx: RouteContext): RouteTable {
  return {
    "/api/projects/:id/run-review": { GET: async req => {
      const project = id(req.params.id);
      const params = new URL(req.url).searchParams;
      const engine = id(params.get("engineId")), selected = params.get("preset");
      const offset = params.get("offset") ?? "0";
      if (project === null || engine === null || !preset(selected) || !/^\d{1,9}$/.test(offset)) return errorResponse(400, "api.invalid_body");
      const result = await ctx.projectRuns.review(project, engine, selected, Number(offset));
      return result.ok ? Response.json(result.value) : errorResponse(result.status, result.error.code, result.error.data);
    }, POST: async req => {
      const project = id(req.params.id);
      const parsed = await readJson(req);
      if (!parsed.ok) return parsed.response;
      const { engineId, preset: selected, options, presetName, sourceRunId, offset = 0 } = parsed.body;
      if (project === null || typeof engineId !== "number" || id(engineId) === null || !preset(selected) || !edits(options) || !named(presetName) || sourceRunId !== undefined && (typeof sourceRunId !== "number" || id(sourceRunId) === null) || !Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 999999999 || Object.keys(parsed.body).some(key => !["engineId", "preset", "options", "offset", "presetName", "sourceRunId"].includes(key))) return errorResponse(400, "api.invalid_body");
      const result = await ctx.projectRuns.review(project, engineId, selected, offset as number, options, presetName?.trim(), sourceRunId as number | undefined);
      return result.ok ? Response.json(result.value) : errorResponse(result.status, result.error.code, result.error.data);
    } },
    "/api/projects/:id/runs": { GET: req => {
      const project = id(req.params.id);
      if (project === null || !ctx.projects.get(project)) return errorResponse(404, "project.not_found");
      const offset = new URL(req.url).searchParams.get("offset") ?? "0";
      if (!/^\d{1,9}$/.test(offset)) return errorResponse(400, "api.invalid_body");
      return Response.json(ctx.projectRuns.list(project, Number(offset)));
    }, POST: async req => {
      const project = id(req.params.id);
      const parsed = await readJson(req);
      if (!parsed.ok) return parsed.response;
      const { engineId, preset: selected, name, revision, options, presetName, sourceRunId } = parsed.body;
      if (project === null || typeof engineId !== "number" || id(engineId) === null || !preset(selected) || typeof name !== "string" || !name.trim() || name.trim().length > 200 || typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) return errorResponse(400, "api.invalid_body");
      if (!edits(options) || !named(presetName) || sourceRunId !== undefined && (typeof sourceRunId !== "number" || id(sourceRunId) === null) || Object.keys(parsed.body).some(key => !["engineId", "preset", "name", "revision", "options", "presetName", "sourceRunId"].includes(key))) return errorResponse(400, "api.invalid_body");
      const result = await ctx.projectRuns.start(project, { engineId, preset: selected, name: name.trim(), revision, options, presetName: presetName?.trim(), sourceRunId: sourceRunId as number | undefined });
      return result.ok ? Response.json(result.value, { status: 202 }) : errorResponse(result.status, result.error.code, result.error.data);
    } },
  };
}
