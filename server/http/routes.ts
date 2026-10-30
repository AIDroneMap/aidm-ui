import { linkRoutes } from "../projects/link-routes.ts";
import { projectRunRoutes } from "../projects/run-routes.ts";
import { importRoutes } from "../projects/import-routes.ts";
import { errorResponse } from "../../shared/api-error.ts";
import { authRoutes } from "../auth/routes.ts";
import { engineRoutes } from "../engines/routes.ts";
import { localEngineRoutes } from "../local-engine/routes.ts";
import { machineRoutes } from "../machine/routes.ts";
import { manifestRoutes } from "../manifest/routes.ts";
import { projectRoutes } from "../projects/routes.ts";
import { runRoutes } from "../runs/routes.ts";
import { sampleRoutes } from "../sample/routes.ts";
import { settingsRoutes } from "../settings/routes.ts";
import type { GuardedHandler, ServeRoutes } from "./listener.ts";
import { bodyLimitOf, type Method, type RouteContext, type RouteHandler, type RouteTable } from "./route-table.ts";
import { withSecurityHeaders } from "./security-headers.ts";
import { serveAsset } from "./static-assets.ts";

export type { RouteContext } from "./route-table.ts";

/** The answer for every path that is not an API path. */
function interfaceResponse(ctx: RouteContext, req: Request): Response {
  if (req.method !== "GET") return errorResponse(405, "api.method_not_allowed");
  const { pathname } = new URL(req.url);
  return serveAsset(ctx.assets, pathname) ?? errorResponse(404, "interface.not_built");
}

function healthRoutes(ctx: RouteContext): RouteTable {
  return { "/api/health": { GET: () => Response.json(ctx.identity) } };
}

/** Every API route. */
export function apiRoutes(ctx: RouteContext): RouteTable {
  return {
    ...healthRoutes(ctx),
    ...settingsRoutes(ctx),
    ...authRoutes(ctx),
    ...engineRoutes(ctx),
    ...localEngineRoutes(ctx),
    ...machineRoutes(ctx),
    ...manifestRoutes(ctx),
    ...sampleRoutes(ctx),
    ...runRoutes(ctx),
    ...projectRoutes(ctx),
    ...importRoutes(ctx),
    ...linkRoutes(ctx),
    ...projectRunRoutes(ctx),
  };
}

/**
 * Wraps a handler in the one guard every route goes through: who is asking,
 * whether they may, and what to say if the handler fails.
 */
function guarded(ctx: RouteContext, handler: RouteHandler): GuardedHandler {
  const bodyLimit = bodyLimitOf(handler);
  return async (req, server) => {
    // No address (it should not happen on a TCP listener) counts as not loopback.
    const client = { address: server.requestIP(req)?.address ?? "" };
    try {
      const refusal = await ctx.auth().authorize(req, client);
      if (refusal !== null) return withSecurityHeaders(refusal);
      // Bun lets the largest body of any route through, so each route is held to its own.
      const declared = Number(req.headers.get("content-length"));
      if (declared > bodyLimit) return withSecurityHeaders(errorResponse(413, "api.body_too_large"));
      return withSecurityHeaders(await handler(req, { client, server }));
    } catch (error) {
      ctx.log(`Request ${req.method} ${new URL(req.url).pathname} failed: ${describeError(error)}`);
      return withSecurityHeaders(errorResponse(500, "server.internal_error"));
    }
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/** The routes option of Bun.serve. */
export function createRoutes(ctx: RouteContext, table: RouteTable = apiRoutes(ctx)): ServeRoutes {
  const routes: ServeRoutes = {};
  for (const [path, methods] of Object.entries(table)) {
    const wrapped: Partial<Record<Method, GuardedHandler>> = {};
    for (const [method, handler] of Object.entries(methods) as Array<[Method, RouteHandler]>) {
      wrapped[method] = guarded(ctx, handler);
    }
    routes[path] = wrapped;
  }
  routes["/api/*"] = guarded(ctx, () => errorResponse(404, "api.not_found"));
  routes["/*"] = guarded(ctx, (req) => interfaceResponse(ctx, req));
  return routes;
}

/**
 * The wildcard routes cover every path and method, so this answers only if
 * Bun ever lets a request through them.
 */
export function fallbackFetch(): (req: Request) => Response {
  return () => withSecurityHeaders(errorResponse(405, "api.method_not_allowed"));
}
