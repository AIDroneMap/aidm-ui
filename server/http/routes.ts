import { errorResponse } from "../../shared/api-error.ts";
import type { InstanceIdentity } from "../app/instance.ts";
import { withSecurityHeaders } from "./security-headers.ts";
import { serveAsset, type AssetMap } from "./static-assets.ts";

export interface RouteContext {
  identity: InstanceIdentity;
  assets: AssetMap;
}

/** The answer for every path that is not an API path. */
function interfaceResponse(ctx: RouteContext, req: Request): Response {
  if (req.method !== "GET") return errorResponse(405, "api.method_not_allowed");
  const { pathname } = new URL(req.url);
  return serveAsset(ctx.assets, pathname) ?? errorResponse(404, "interface.not_built");
}

/** The routes option of Bun.serve. */
export function createRoutes(ctx: RouteContext) {
  return {
    "/api/health": {
      GET: () => withSecurityHeaders(Response.json(ctx.identity)),
    },
    "/api/*": () => withSecurityHeaders(errorResponse(404, "api.not_found")),
    "/*": (req: Request) => withSecurityHeaders(interfaceResponse(ctx, req)),
  };
}

/**
 * The wildcard routes cover every path and method, so this answers only if
 * Bun ever lets a request through them.
 */
export function fallbackFetch(): (req: Request) => Response {
  return () => withSecurityHeaders(errorResponse(405, "api.method_not_allowed"));
}
