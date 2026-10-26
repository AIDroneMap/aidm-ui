import { errorResponse } from "../../shared/api-error.ts";
import type { MachineCheckView, WizardView } from "../../shared/api-types.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";
import { checkMachine } from "./check.ts";

function wizardView(ctx: RouteContext): WizardView {
  return { completed: ctx.settings.get("wizard.completed") };
}

/** A read older than this runs the check again. */
export const MACHINE_CHECK_MAX_AGE_MS = 60_000;

export function machineRoutes(ctx: RouteContext): RouteTable {
  let last: { view: MachineCheckView; at: number } | null = null;
  let running: Promise<MachineCheckView> | null = null;
  // The check that waits for the one in flight to finish.
  let queued: Promise<MachineCheckView> | null = null;

  const execute = async (): Promise<MachineCheckView> => {
    const facts = await ctx.machine.gather();
    const at = ctx.now();
    const view = checkMachine(facts, { preferredRuntime: ctx.settings.get("runtime.preferred"), now: at });
    last = { view, at };
    return view;
  };

  const start = (): Promise<MachineCheckView> => {
    const run = execute().finally(() => {
      if (running === run) running = null;
    });
    running = run;
    return run;
  };

  // A read takes the last answer while it is fresh, and joins a check that is already running.
  const read = (): Promise<MachineCheckView> | MachineCheckView => {
    if (last !== null && ctx.now() - last.at <= MACHINE_CHECK_MAX_AGE_MS) return last.view;
    return running ?? start();
  };

  // "Check again" must see the computer as it is after the click, so it never shares an answer that began before it.
  const fresh = (): Promise<MachineCheckView> => {
    if (running === null) return start();
    queued ??= running
      .catch(() => {})
      .then(() => {
        queued = null;
        // A read that began in the gap also began after the click, so it may be joined.
        return running ?? start();
      });
    return queued;
  };

  return {
    "/api/machine-check": {
      GET: async () => Response.json(await read()),
      POST: async () => Response.json(await fresh()),
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
