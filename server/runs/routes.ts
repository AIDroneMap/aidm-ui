import { errorResponse } from "../../shared/api-error.ts";
import type { RouteContext, RouteTable } from "../http/route-table.ts";


function parseId(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

export function runRoutes(ctx: RouteContext): RouteTable {
  const { tracker } = ctx;

  return {
    "/api/runs/:id": {
      GET: (req) => {
        const id = parseId(req.params.id ?? "");
        const view = id === null ? null : tracker.view(id);
        return view === null ? errorResponse(404, "run.not_found") : Response.json(view);
      },
    },

    "/api/runs/:id/cancel": {
      POST: async (req) => {
        const id = parseId(req.params.id ?? "");
        if (id === null) return errorResponse(404, "run.not_found");
        const preparation = await ctx.projectRuns.cancel(id);
        if (preparation) return preparation.ok ? Response.json(preparation.value) : errorResponse(preparation.status, preparation.error.code, preparation.error.data);
        const outcome = await ctx.sample.cancel(id);
        return outcome.ok ? Response.json(outcome.run) : errorResponse(outcome.status, outcome.error.code, outcome.error.data);
      },
    },

    "/api/runs/:id/log": {
      GET: (req) => {
        const id = parseId(req.params.id ?? "");
        if (id === null || tracker.view(id) === null) return errorResponse(404, "run.not_found");
        const from = parseId(new URL(req.url).searchParams.get("from") ?? "0");
        return Response.json(tracker.log(id, from ?? 0));
      },
    },

    "/api/runs/:id/events": {
      GET: (req, rc) => {
        const id = parseId(req.params.id ?? "");
        if (id === null || tracker.view(id) === null) return errorResponse(404, "run.not_found");
        // The stream stays open for as long as the page does, so the idle timeout must not cut it.
        rc.server.timeout(req, 0);
        return ctx.streams.respond(rc.client, (send) => {
          const unsubscribe = tracker.subscribe(id, (event) => {
            if (event.type === "run") send(`event: run\ndata: ${JSON.stringify(event.run)}\n\n`);
            else send(`event: log\ndata: ${JSON.stringify({ lines: event.lines, from: event.from })}\n\n`);
          });
          send(`event: run\ndata: ${JSON.stringify(tracker.view(id))}\n\n`);
          // Only the newest lines: the page asks the log route for older ones.
          const recent = tracker.recentLog(id);
          send(`event: log\ndata: ${JSON.stringify(recent)}\n\n`);
          return unsubscribe;
        });
      },
    },

    "/api/runs/:id/results": {
      GET: (req) => {
        const run = tracker.record(Number(req.params.id));
        if (!run) return errorResponse(404, "run.not_found");
        return tracker.results.response(run, req) ?? errorResponse(409, "run.results_not_ready");
      },
      DELETE: async (req) => {
        const run = tracker.record(Number(req.params.id));
        if (!run) return errorResponse(404, "run.not_found");
        if (run.state !== "completed" || !await tracker.results.delete(run)) return errorResponse(409, "run.results_not_ready");
        return Response.json(tracker.view(run.id));
      },
      POST: (req) => {
        const run = tracker.record(Number(req.params.id));
        if (!run) return errorResponse(404, "run.not_found");
        if (!tracker.results.ensure(run, true)) return errorResponse(409, "run.results_not_ready");
        return Response.json(tracker.view(run.id), { status: 202 });
      },
    },
    "/api/runs/:id/outputs/:name": {
      GET: (req) => {
        const run = tracker.record(Number(req.params.id));
        if (!run) return errorResponse(404, "run.not_found");
        return tracker.results.response(run, req, req.params.name) ?? errorResponse(409, "run.results_not_ready");
      },
    },
    "/api/runs/:id/tiles/:layer/:z/:x/:y": {
      GET: (req) => {
        const run = tracker.record(Number(req.params.id));
        if (!run) return errorResponse(404, "run.not_found");
        const layers: Record<string, string> = { orthophoto: "orthophoto_tiles", surface: "dsm_tiles", ground: "dtm_tiles" };
        const layer = layers[req.params.layer ?? ""];
        const { z, x, y } = req.params;
        if (!layer || !/^\d{1,2}$/.test(z ?? "") || !/^\d{1,10}$/.test(x ?? "") || !/^\d{1,10}\.png$/.test(y ?? "")) return errorResponse(404, "api.not_found");
        return tracker.results.response(run, req, undefined, `${layer}/${z}/${x}/${y}`) ?? errorResponse(409, "run.results_not_ready");
      },
    },
  };
}
