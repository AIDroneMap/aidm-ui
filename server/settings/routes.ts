import { errorResponse } from "../../shared/api-error.ts";
import { isBasemapSettings } from "../../shared/basemap.ts";
import {
  PASSPHRASE_MAX_LENGTH,
  PASSPHRASE_MIN_LENGTH,
  PORT_MAX,
  PORT_MIN,
  type SettingsView,
} from "../../shared/api-types.ts";
import { ALL_INTERFACES, LOOPBACK } from "../http/listener.ts";
import { isLoopbackAddress } from "../auth/hook.ts";
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

/** Long enough for the answer to reach the browser before the listener closes its connections. */
const REBIND_DELAY_MS = 200;

/**
 * Moves the listener once the answer is on its way. If it cannot move, the
 * setting goes back to what it was, so the screen never says the network is
 * open (or closed) when it is not.
 */
function rebindSoon(ctx: RouteContext, hostname: string, undo: () => void): void {
  setTimeout(() => {
    ctx.rebind(hostname).catch((error: unknown) => {
      undo();
      const reason = error instanceof Error ? error.message : String(error);
      ctx.log(`Could not listen on ${hostname}: ${reason}. The local network setting is back to what it was.`);
    });
  }, REBIND_DELAY_MS);
}

export function settingsRoutes(ctx: RouteContext): RouteTable {
  return {
    "/api/settings": {
      GET: () => Response.json(settingsView(ctx)),
    },

    "/api/settings/basemap": {
      GET: () => Response.json(ctx.settings.get("map.basemap")),
      PUT: async (req) => {
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response.status === 400 ? errorResponse(400, "settings.basemap_invalid") : parsed.response;
        if (!isBasemapSettings(parsed.body)) return errorResponse(400, "settings.basemap_invalid");
        const { enabled, url, scheme, attribution } = parsed.body;
        const value = { enabled, url, scheme, attribution };
        ctx.settings.set("map.basemap", value);
        return Response.json(value);
      },
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
      PUT: async (req, { client }) => {
        // A device on the network that knows the passphrase must not be able to
        // open the door wider, or lock the operator's own computer out of the switch.
        if (!isLoopbackAddress(client.address)) return errorResponse(403, "settings.lan_local_only");
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.response;
        const { enabled, passphrase } = parsed.body;
        if (typeof enabled !== "boolean") return errorResponse(400, "api.invalid_body");

        let newHash: string | null = null;
        if (enabled) {
          if (typeof passphrase !== "string" || passphrase.length > PASSPHRASE_MAX_LENGTH) {
            return errorResponse(400, "api.invalid_body");
          }
          if ([...passphrase].length < PASSPHRASE_MIN_LENGTH) {
            return errorResponse(400, "settings.passphrase_too_short", { min: PASSPHRASE_MIN_LENGTH });
          }
          newHash = await Bun.password.hash(passphrase, "argon2id");
        }

        const before = { enabled: ctx.settings.get("lan.enabled"), hash: ctx.settings.get("lan.passphraseHash") };
        ctx.settings.set("lan.passphraseHash", newHash);
        ctx.settings.set("lan.enabled", enabled);
        // Anyone signed in with the old passphrase, or while the switch was on, signs in again.
        ctx.sessions.clear();
        rebindSoon(ctx, enabled ? ALL_INTERFACES : LOOPBACK, () => {
          ctx.settings.set("lan.passphraseHash", before.hash);
          ctx.settings.set("lan.enabled", before.enabled);
          ctx.sessions.clear();
        });
        return Response.json(settingsView(ctx, enabled));
      },
    },
  };
}
