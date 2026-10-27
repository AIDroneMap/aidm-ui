import { errorResponse } from "../../shared/api-error.ts";
import {
  RUNTIME_IDS,
  type CapsRequest,
  type ForceCpuRequest,
  type LocalEngineEnabledRequest,
  type RuntimeChoiceRequest,
  type RuntimeId,
} from "../../shared/api-types.ts";
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
        await localEngine.refreshUpdateOffer();
        return Response.json(localEngine.view());
      },
    },

    "/api/local-engine/events": {
      GET: (req, rc) => {
        // The stream stays open for as long as the page does, so the idle timeout must not cut it.
        rc.server.timeout(req, 0);
        return ctx.streams.respond(rc.client, (send) => {
          const sendView = (view: unknown) => send(`event: local-engine\ndata: ${JSON.stringify(view)}\n\n`);
          const sendSetup = (view: unknown) => send(`event: runtime-setup\ndata: ${JSON.stringify(view)}\n\n`);
          const unsubscribe = localEngine.subscribe(sendView);
          const unsubscribeSetup = ctx.runtimeSetup.subscribe(sendSetup);
          sendView(localEngine.view());
          const setup = ctx.runtimeSetup.view();
          if (setup !== null) sendSetup(setup);
          // The runtimes may have changed since the last look. The listener hears about it if they did.
          void localEngine.refreshRuntimes(DETECTION_MAX_AGE_MS);
          void localEngine.refreshUpdateOffer();
          return () => {
            unsubscribe();
            unsubscribeSetup();
          };
        });
      },
    },

    "/api/local-engine/install": {
      // One button for the operator. Where no container tool works and Podman can be set up, this starts the setup,
      // which carries on with the install itself, so a page that reloads in between still sees it through.
      POST: async () => {
        if (ctx.runtimeSetup.isRunning()) return errorResponse(409, "setup.already_running");
        const outcome = await localEngine.install();
        if (!outcome.ok) {
          if (outcome.error.code === "install.no_runtime") {
            const started = await ctx.runtimeSetup.start();
            if (started.ok) return Response.json(localEngine.view(), { status: 202 });
            if (started.error.code === "setup.already_running") {
              return errorResponse(started.status, started.error.code, started.error.data);
            }
          }
          return errorResponse(outcome.status, outcome.error.code, outcome.error.data);
        }
        return Response.json(localEngine.view(), { status: 202 });
      },
    },

    "/api/local-engine/setup-runtime": {
      // Answers at once; the steps (approval, install, check) come as "runtime-setup" events.
      POST: async () => {
        const started = await ctx.runtimeSetup.start();
        if (!started.ok) return errorResponse(started.status, started.error.code, started.error.data);
        return Response.json(ctx.runtimeSetup.view(), { status: 202 });
      },
    },

    // Ends the wait for the password of macOS. The page offers it only at that step; at any other time it changes nothing.
    "/api/local-engine/install/cancel": {
      POST: () => {
        localEngine.stopWaitingForApproval();
        return Response.json(localEngine.view());
      },
    },

    // Both answer once the work has started. The page follows it through the live view.
    "/api/local-engine/update": {
      POST: async () => {
        const outcome = await localEngine.update();
        if (!outcome.ok) return errorResponse(outcome.status, outcome.error.code, outcome.error.data);
        return Response.json(localEngine.view(), { status: 202 });
      },
    },
    "/api/local-engine/rollback": {
      POST: async () => {
        const outcome = await localEngine.rollback();
        if (!outcome.ok) return errorResponse(outcome.status, outcome.error.code, outcome.error.data);
        return Response.json(localEngine.view(), { status: 202 });
      },
    },

    "/api/local-engine/network/move": {
      // Restarts Apple's tool and every container on it, so the page asks first and the body says it did.
      POST: async (req) => {
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        if ((parsed.body as { confirm?: unknown }).confirm !== true) return errorResponse(400, "api.invalid_body");
        const moved = await localEngine.moveNetwork();
        if (!moved.ok) return errorResponse(moved.status, moved.error.code, moved.error.data);
        return Response.json(localEngine.view());
      },
    },

    "/api/local-engine/start": {
      // Also the way back from every failure while the switch is on, and it ends a restart that is waiting.
      POST: async () => {
        const started = await localEngine.start();
        if (!started.ok) return errorResponse(409, started.error.code, started.error.data);
        return Response.json(localEngine.view());
      },
    },

    "/api/local-engine/enabled": {
      PUT: async (req) => {
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        const { enabled } = parsed.body as Partial<Record<keyof LocalEngineEnabledRequest, unknown>>;
        if (typeof enabled !== "boolean") return errorResponse(400, "api.invalid_body");
        const changed = await localEngine.setEnabled(enabled);
        if (!changed.ok) return errorResponse(409, changed.error.code, changed.error.data);
        return Response.json(localEngine.view());
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

    "/api/local-engine/force-cpu": {
      PUT: async (req) => {
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        const { forceCpu } = parsed.body as Partial<Record<keyof ForceCpuRequest, unknown>>;
        if (typeof forceCpu !== "boolean") return errorResponse(400, "api.invalid_body");
        localEngine.setForceCpu(forceCpu);
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
