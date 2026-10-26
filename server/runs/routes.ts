import { errorResponse } from "../../shared/api-error.ts";
import { failureResponse } from "../engines/routes.ts";
import type { RouteContext, RouteTable } from "../http/route-table.ts";

const KEEP_ALIVE_MS = 15_000;

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
        const encoder = new TextEncoder();
        let unsubscribe = () => {};
        let keepAlive: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (text: string) => {
              try {
                controller.enqueue(encoder.encode(text));
              } catch {
                // The client is gone; cancel() cleans up.
              }
            };
            unsubscribe = tracker.subscribe(id, (event) => {
              if (event.type === "run") send(`event: run\ndata: ${JSON.stringify(event.run)}\n\n`);
              else send(`event: log\ndata: ${JSON.stringify({ lines: event.lines, from: event.from })}\n\n`);
            });
            send(`event: run\ndata: ${JSON.stringify(tracker.view(id))}\n\n`);
            const saved = tracker.log(id, 0);
            send(`event: log\ndata: ${JSON.stringify({ lines: saved.lines, from: 0 })}\n\n`);
            keepAlive = setInterval(() => send(": keep-alive\n\n"), KEEP_ALIVE_MS);
          },
          cancel() {
            unsubscribe();
            clearInterval(keepAlive);
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
        });
      },
    },

    "/api/runs/:id/results": {
      GET: async (req) => {
        const id = parseId(req.params.id ?? "");
        if (id === null || tracker.view(id) === null) return errorResponse(404, "run.not_found");
        const opened = await tracker.openResults(id);
        if (opened === null) return errorResponse(409, "run.results_not_ready");
        if (!opened.ok) return failureResponse(opened.failure);
        // The engine's body goes straight on, never held in memory here.
        const headers = new Headers({
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="sample-job-results.zip"',
          "Cache-Control": "no-store",
        });
        const length = opened.value.headers.get("content-length");
        if (length !== null) headers.set("Content-Length", length);
        return new Response(opened.value.body, { headers });
      },
    },
  };
}
