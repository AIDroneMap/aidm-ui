import { errorResponse } from "../../shared/api-error.ts";
import { RUNTIME_IDS, type CapsRequest, type RuntimeChoiceRequest, type RuntimeId } from "../../shared/api-types.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";
import { LOG_MEMORY_LINES } from "./engine-log.ts";

/** New log lines are sent together, at most this often, so a chatty engine does not make one event and one page update per line. */
export const LOG_BATCH_MS = 100;

/** The runtimes answer slowly the first time; a page asking again soon gets the last answer. */
const DETECTION_MAX_AGE_MS = 30_000;

function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === "string" && (RUNTIME_IDS as readonly string[]).includes(value);
}

export function localEngineRoutes(ctx: RouteContext): RouteTable {
  const { localEngine } = ctx;

  return {
    "/api/local-engine": {
      GET: async () => {
        await localEngine.refreshRuntimes(DETECTION_MAX_AGE_MS);
        return Response.json(localEngine.view());
      },
    },

    "/api/local-engine/events": {
      GET: (req, rc) => {
        // The stream stays open for as long as the page does, so the idle timeout must not cut it.
        rc.server.timeout(req, 0);
        return ctx.streams.respond(rc.client, (send) => {
          const sendView = (view: unknown) => send(`event: local-engine\ndata: ${JSON.stringify(view)}\n\n`);
          const unsubscribe = localEngine.subscribe(sendView);
          sendView(localEngine.view());
          // The runtimes may have changed since the last look. The listener hears about it if they did.
          void localEngine.refreshRuntimes(DETECTION_MAX_AGE_MS);
          return unsubscribe;
        });
      },
    },

    "/api/local-engine/install": {
      POST: async () => {
        const outcome = await localEngine.install();
        if (!outcome.ok) return errorResponse(outcome.status, outcome.error.code, outcome.error.data);
        return Response.json(localEngine.view(), { status: 202 });
      },
    },

    "/api/local-engine/logs": {
      GET: (req, rc) => {
        rc.server.timeout(req, 0);
        return ctx.streams.respond(rc.client, (send) => {
          const sendLines = (lines: string[]) => send(`event: log\ndata: ${JSON.stringify({ lines })}\n\n`);
          const waiting: string[] = [];
          let timer: ReturnType<typeof setTimeout> | undefined;
          const flush = () => {
            timer = undefined;
            if (waiting.length > 0) sendLines(waiting.splice(0));
          };
          // Subscribed before the history is read, in one step, so no line falls between the two.
          const unsubscribe = localEngine.logs.subscribe((lines) => {
            waiting.push(...lines);
            timer ??= setTimeout(flush, LOG_BATCH_MS);
          });
          sendLines(localEngine.logs.lines().slice(-LOG_MEMORY_LINES));
          return () => {
            unsubscribe();
            clearTimeout(timer);
          };
        });
      },
    },

    "/api/local-engine/caps": {
      PUT: async (req) => {
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        const { memoryBytes, cpus } = parsed.body as Partial<Record<keyof CapsRequest, unknown>>;
        if (typeof memoryBytes !== "number" || typeof cpus !== "number") return errorResponse(400, "api.invalid_body");
        const result = localEngine.setCaps({ memoryBytes, cpus });
        if (!result.ok) return errorResponse(400, result.error.code, result.error.data);
        return Response.json(localEngine.view());
      },
    },

    "/api/settings/runtime": {
      PUT: async (req) => {
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        const { runtime } = parsed.body as Partial<Record<keyof RuntimeChoiceRequest, unknown>>;
        if (runtime !== null && !isRuntimeId(runtime)) return errorResponse(400, "api.invalid_body");
        const result = await localEngine.chooseRuntime(runtime);
        if (!result.ok) return errorResponse(409, result.error.code, result.error.data);
        return Response.json(localEngine.view());
      },
    },
  };
}
