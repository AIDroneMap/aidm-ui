import { errorResponse } from "../../shared/api-error.ts";
import type { WizardView } from "../../shared/api-types.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";

function wizardView(ctx: RouteContext): WizardView {
  return { completed: ctx.settings.get("wizard.completed") };
}

export function machineRoutes(ctx: RouteContext): RouteTable {
  return {
    "/api/machine-check": {
      GET: async () => Response.json(await ctx.machineChecks.read()),
      POST: async () => Response.json(await ctx.machineChecks.fresh()),
    },

    "/api/wizard": {
      GET: () => Response.json(wizardView(ctx)),
      PUT: async (req) => {
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        if (typeof parsed.body.completed !== "boolean") return errorResponse(400, "api.invalid_body");
        ctx.settings.set("wizard.completed", parsed.body.completed);
        return Response.json(wizardView(ctx));
      },
    },
  };
}
