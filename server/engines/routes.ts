import { errorResponse, type ApiError } from "../../shared/api-error.ts";
import type { EngineAddRequest, EngineTestView } from "../../shared/api-types.ts";
import { readJson, type RouteContext, type RouteTable } from "../http/route-table.ts";
import { TaskClient, type TaskApiFailure } from "../task-api/task-client.ts";
import { checkEngineAddress } from "./address-rule.ts";
import { isSupportedVersion } from "./versions.ts";

const KEEP_ALIVE_MS = 15_000;
const MAX_NAME_CHARS = 200;
const MAX_ADDRESS_CHARS = 2048;
const MAX_TOKEN_CHARS = 4096;

type Fields = Record<string, unknown>;

function isString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length <= maxChars;
}

/** The refusal for a failed call to the engine. Details go to the log, never to the browser. */
function failureResponse(failure: TaskApiFailure): Response {
  switch (failure.kind) {
    case "unreachable":
      return errorResponse(502, "engine.unreachable");
    case "engine_error":
      return errorResponse(502, "engine.error", { message: failure.message });
    case "bad_response":
      return errorResponse(502, "engine.bad_response");
  }
}

/** A name that does not resolve is the engine being unreachable; the other refusals are the operator's typing. */
function addressRefusal(error: ApiError): Response {
  return errorResponse(error.code === "engine.unreachable" ? 502 : 400, error.code, error.data);
}

function parseId(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

export function engineRoutes(ctx: RouteContext): RouteTable {
  const { engines, engineStore: store } = ctx;

  async function testEngine(fields: Fields): Promise<Response> {
    const { address, token } = fields;
    if (!isString(address, MAX_ADDRESS_CHARS) || !isString(token, MAX_TOKEN_CHARS)) {
      return errorResponse(400, "api.invalid_body");
    }
    const checked = await checkEngineAddress(address);
    if (!checked.ok) return addressRefusal(checked.error);

    const result = await new TaskClient({ address: checked.address, token }, { log: ctx.log }).info();
    if (!result.ok) return failureResponse(result.failure);
    const view: EngineTestView = {
      info: result.value,
      supported: isSupportedVersion(result.value.version),
      warning: checked.warning,
    };
    return Response.json(view);
  }

  async function addEngine(fields: Fields): Promise<Response> {
    const { name, address, token } = fields as Partial<Record<keyof EngineAddRequest, unknown>>;
    if (!isString(address, MAX_ADDRESS_CHARS) || !isString(token, MAX_TOKEN_CHARS) || typeof name !== "string") {
      return errorResponse(400, "api.invalid_body");
    }
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > MAX_NAME_CHARS) return errorResponse(400, "engine.name_required");
    const checked = await checkEngineAddress(address);
    if (!checked.ok) return addressRefusal(checked.error);

    const engine = store.addRemote({ name: trimmed, address: checked.address, token });
    await engines.pollNow(engine.id);
    const view = engines.views().find((candidate) => candidate.id === engine.id);
    return Response.json(view, { status: 201 });
  }

  async function editEngine(id: number, fields: Fields): Promise<Response> {
    const current = store.get(id);
    if (current === null || current.kind !== "remote") return errorResponse(404, "engine.not_found");

    const patch: { name?: string; address?: string; token?: string; enabled?: boolean } = {};
    if ("name" in fields) {
      if (typeof fields.name !== "string") return errorResponse(400, "api.invalid_body");
      const trimmed = fields.name.trim();
      if (trimmed === "" || trimmed.length > MAX_NAME_CHARS) return errorResponse(400, "engine.name_required");
      patch.name = trimmed;
    }
    if ("token" in fields) {
      if (!isString(fields.token, MAX_TOKEN_CHARS)) return errorResponse(400, "api.invalid_body");
      patch.token = fields.token;
    }
    if ("enabled" in fields) {
      if (typeof fields.enabled !== "boolean") return errorResponse(400, "api.invalid_body");
      patch.enabled = fields.enabled;
    }
    if ("address" in fields) {
      if (!isString(fields.address, MAX_ADDRESS_CHARS)) return errorResponse(400, "api.invalid_body");
      const checked = await checkEngineAddress(fields.address);
      if (!checked.ok) return addressRefusal(checked.error);
      patch.address = checked.address;
    }

    // The engine may have been removed while the address was checked.
    if (store.update(id, patch) === null) return errorResponse(404, "engine.not_found");
    await engines.pollNow(id);
    return Response.json(engines.views().find((candidate) => candidate.id === id));
  }

  return {
    "/api/engines": {
      GET: () => Response.json(engines.views()),
      POST: async (req) => {
        const parsed = await readJson(req);
        return parsed.ok ? addEngine(parsed.body) : parsed.response;
      },
    },

    "/api/engines/test": {
      POST: async (req) => {
        const parsed = await readJson(req);
        return parsed.ok ? testEngine(parsed.body) : parsed.response;
      },
    },

    "/api/engines/events": {
      GET: (req, rc) => {
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
            const sendViews = (views: unknown) => send(`event: engines\ndata: ${JSON.stringify(views)}\n\n`);
            unsubscribe = engines.subscribe(sendViews);
            sendViews(engines.views());
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

    "/api/engines/:id": {
      PUT: async (req) => {
        const id = parseId(req.params.id ?? "");
        if (id === null || store.get(id) === null) return errorResponse(404, "engine.not_found");
        const parsed = await readJson(req);
        return parsed.ok ? editEngine(id, parsed.body) : parsed.response;
      },
      DELETE: async (req) => {
        const id = parseId(req.params.id ?? "");
        const engine = id === null ? null : store.get(id);
        if (id === null || engine === null || engine.kind !== "remote") return errorResponse(404, "engine.not_found");
        store.remove(id);
        await engines.pollNow(id);
        return new Response(null, { status: 204 });
      },
    },
  };
}
