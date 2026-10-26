import { errorResponse } from "../../shared/api-error.ts";
import type { MachineCheckView, WizardView } from "../../shared/api-types.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";
import { checkMachine } from "./check.ts";

function wizardView(ctx: RouteContext): WizardView {
  return { completed: ctx.settings.get("wizard.completed") };
}

export function machineRoutes(ctx: RouteContext): RouteTable {
  let last: MachineCheckView | null = null;
  // Two screens asking at once share one run.
  let running: Promise<MachineCheckView> | null = null;

  const run = (): Promise<MachineCheckView> => {
    running ??= (async () => {
      try {
        const facts = await ctx.machine.gather();
        last = checkMachine(facts, { preferredRuntime: ctx.settings.get("runtime.preferred"), now: ctx.now() });
        return last;
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return {
    "/api/machine-check": {
      GET: async () => Response.json(last ?? (await run())),
      POST: async () => Response.json(await run()),
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
