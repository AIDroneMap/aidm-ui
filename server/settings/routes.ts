import { errorResponse } from "../../shared/api-error.ts";
import {
  PASSPHRASE_MIN_LENGTH,
  PORT_MAX,
  PORT_MIN,
  type SettingsView,
} from "../../shared/api-types.ts";
import { ALL_INTERFACES, LOOPBACK } from "../http/listener.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";
import { lanAddresses } from "./network.ts";

function settingsView(ctx: RouteContext, lanEnabled = ctx.settings.get("lan.enabled")): SettingsView {
  return {
    port: ctx.settings.get("server.port"),
    listeningPort: ctx.listeningPort(),
    lan: { enabled: lanEnabled, addresses: lanAddresses() },
  };
}

function isValidPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= PORT_MIN && (value as number) <= PORT_MAX;
}

/** Moves the listener once the answer is on its way, so the browser still gets it. */
function rebindSoon(ctx: RouteContext, hostname: string): void {
  setTimeout(() => {
    ctx.rebind(hostname).catch((error: unknown) => {
      ctx.log(`Could not listen on ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 0);
}

export function settingsRoutes(ctx: RouteContext): RouteTable {
  return {
    "/api/settings": {
      GET: () => Response.json(settingsView(ctx)),
    },

    "/api/settings/port": {
      PUT: async (req) => {
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        if (!("port" in parsed.body)) return errorResponse(400, "api.invalid_body");
        const { port } = parsed.body;
        if (port !== null && !isValidPort(port)) {
          return errorResponse(400, "settings.port_invalid", { min: PORT_MIN, max: PORT_MAX });
        }
        ctx.settings.set("server.port", port);
        return Response.json(settingsView(ctx));
      },
    },

    "/api/settings/lan": {
      PUT: async (req) => {
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        const { enabled, passphrase } = parsed.body;
        if (typeof enabled !== "boolean") return errorResponse(400, "api.invalid_body");

        if (enabled) {
          if (typeof passphrase !== "string") return errorResponse(400, "api.invalid_body");
          if ([...passphrase].length < PASSPHRASE_MIN_LENGTH) {
            return errorResponse(400, "settings.passphrase_too_short", { min: PASSPHRASE_MIN_LENGTH });
          }
          ctx.settings.set("lan.passphraseHash", await Bun.password.hash(passphrase, "argon2id"));
        } else {
          ctx.settings.set("lan.passphraseHash", null);
        }
        ctx.settings.set("lan.enabled", enabled);
        // Anyone signed in with the old passphrase, or while the switch was on, signs in again.
        ctx.sessions.clear();
        rebindSoon(ctx, enabled ? ALL_INTERFACES : LOOPBACK);
        return Response.json(settingsView(ctx, enabled));
      },
    },
  };
}
