import { errorResponse } from "../../shared/api-error.ts";
import { MAX_RAISED_BODY_BYTES } from "../http/limits.ts";
import { readJson, withBodyLimit, type RouteContext, type RouteTable } from "../http/route-table.ts";

export function sampleRoutes(ctx: RouteContext): RouteTable {
  return {
    "/api/sample": { GET: () => Response.json(ctx.sample.view()) },

    "/api/sample/start": {
      POST: async (req) => {
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        const { engineId } = parsed.body;
        if (typeof engineId !== "number" || !Number.isInteger(engineId)) return errorResponse(400, "api.invalid_body");
        const outcome = await ctx.sample.start(engineId);
        if (!outcome.ok) return errorResponse(outcome.status, outcome.error.code, outcome.error.data);
        return Response.json(outcome.run, { status: 202 });
      },
    },

    // The kept zip of the sample photos: look at it, delete it, or give the server a copy.
    "/api/sample/dataset": {
      GET: () => Response.json(ctx.sample.datasetFile()),
      DELETE: () => {
        const outcome = ctx.sample.deleteDatasetFile();
        if (!outcome.ok) return errorResponse(outcome.status, outcome.error.code, outcome.error.data);
        return Response.json(outcome.dataset);
      },
      // The body is the zip itself, streamed to disk and never held in memory.
      POST: withBodyLimit(MAX_RAISED_BODY_BYTES, async (req) => {
        const header = req.headers.get("content-length");
        const declared = header === null || !Number.isFinite(Number(header)) ? null : Number(header);
        const outcome = await ctx.sample.importDatasetFile(req.body, declared);
        if (!outcome.ok) return errorResponse(outcome.status, outcome.error.code, outcome.error.data);
        return Response.json(outcome.dataset);
      }),
    },
  };
}
