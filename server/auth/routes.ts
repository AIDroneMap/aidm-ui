import { errorResponse } from "../../shared/api-error.ts";
import type { SessionView } from "../../shared/api-types.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";
import { isLoopbackAddress } from "./hook.ts";
import { LoginThrottle } from "./login-throttle.ts";

export function authRoutes(ctx: RouteContext): RouteTable {
  const throttle = new LoginThrottle(ctx.now);

  return {
    "/api/auth/session": {
      GET: (req, { client }) => {
        const view: SessionView = {
          passphraseRequired:
            ctx.settings.get("lan.enabled") &&
            !isLoopbackAddress(client.address) &&
            !ctx.sessions.isValid(ctx.sessions.fromRequest(req)),
        };
        return Response.json(view);
      },
    },

    "/api/auth/login": {
      POST: async (req, { client }) => {
        const hash = ctx.settings.get("lan.passphraseHash");
        if (!ctx.settings.get("lan.enabled") || hash === null) return errorResponse(403, "auth.lan_disabled");
        if (throttle.isBlocked(client.address)) return errorResponse(429, "auth.too_many_attempts");

        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        const { passphrase } = parsed.body;
        if (typeof passphrase !== "string") return errorResponse(400, "api.invalid_body");

        // Counted before the check, so a burst of parallel guesses cannot all slip past the limit.
        throttle.recordFailure(client.address);
        if (!(await Bun.password.verify(passphrase, hash))) return errorResponse(401, "auth.passphrase_wrong");
        throttle.recordSuccess(client.address);
        const headers = new Headers({ "Set-Cookie": ctx.sessions.cookieFor(ctx.sessions.create()) });
        return new Response(null, { status: 204, headers });
      },
    },
  };
}
