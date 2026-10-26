import { errorResponse } from "../../shared/api-error.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";

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
  };
}
