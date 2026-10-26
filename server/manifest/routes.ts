import { errorResponse } from "../../shared/api-error.ts";
import type { RefreshView } from "../../shared/api-types.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";

export function manifestRoutes(ctx: RouteContext): RouteTable {
  const view = async () => {
    const { platform, arch } = await ctx.machine.gather();
    return ctx.localEngine.packages({ platform, arch });
  };

  return {
    "/api/packages": {
      GET: async () => Response.json(await view()),
    },

    // The operator asked for an install or an update, so this reaches the network whatever the update setting says.
    "/api/packages/refresh": {
      POST: async () => {
        const result = await ctx.manifests.refresh();
        const body: RefreshView = { result, view: await view() };
        return Response.json(body);
      },
    },

    "/api/settings/update-check": {
      PUT: async (req) => {
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        const { value } = parsed.body;
        if (value !== "daily" && value !== "never") return errorResponse(400, "api.invalid_body");
        ctx.settings.set("updates.check", value);
        return Response.json(await view());
      },
    },
  };
}
