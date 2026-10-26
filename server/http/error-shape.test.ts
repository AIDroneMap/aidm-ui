import { afterEach, expect, test } from "bun:test";
import { MESSAGE_CODES } from "../../shared/message-codes.ts";
import { openHarness, type Harness } from "../testing/harness.ts";
import type { RouteHandler } from "./route-table.ts";
import { apiRoutes, createRoutes, fallbackFetch } from "./routes.ts";
import { listen } from "./listener.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** Every request the table can answer, plus two that only the wildcards answer. */
function everyRequest(h: Harness): Array<{ method: string; path: string }> {
  const requests: Array<{ method: string; path: string }> = [];
  for (const [path, methods] of Object.entries(apiRoutes(h.ctx))) {
    for (const method of Object.keys(methods)) {
      requests.push({ method, path: path.replace(/:\w+/g, "dummy") });
    }
  }
  // Methods the routes do not offer, and paths nobody defined.
  requests.push({ method: "POST", path: "/api/nothing/here" });
  requests.push({ method: "GET", path: "/api/nothing/here" });
  requests.push({ method: "POST", path: "/some/page" });
  requests.push({ method: "DELETE", path: "/api/health" });
  return requests;
}

/** Fails unless the response is exactly the coded error shape. */
async function expectCodedError(response: Response, what: string): Promise<void> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${what} answered ${response.status} with free text: ${text.slice(0, 80)}`);
  }
  expect(Object.keys(body as object), what).toEqual(["error"]);
  const error = (body as { error: { code: unknown; data?: unknown } }).error;
  expect(MESSAGE_CODES as readonly unknown[], what).toContain(error.code);
  expect(Object.keys(error).sort(), what).toEqual(["code", "data"]);
  expect(typeof error.data === "object" && error.data !== null && !Array.isArray(error.data), what).toBe(true);
  expect(response.headers.get("content-type"), what).toContain("application/json");
}

test("no route answers with free text when the body is not JSON", async () => {
  harness = openHarness();
  for (const { method, path } of everyRequest(harness)) {
    const response = await fetch(`${harness.base}${path}`, {
      method,
      body: method === "GET" ? undefined : "{ this is not json",
    });
    if (response.status >= 400) await expectCodedError(response, `${method} ${path}`);
  }
});

test("no route answers with free text when the body is JSON but not an object", async () => {
  harness = openHarness();
  for (const { method, path } of everyRequest(harness)) {
    if (method === "GET") continue;
    for (const body of ["null", "[1]", '"text"', "7"]) {
      const response = await fetch(`${harness.base}${path}`, { method, body });
      if (response.status >= 400) await expectCodedError(response, `${method} ${path} ${body}`);
    }
  }
});

test("no route answers with free text under a foreign host name", async () => {
  harness = openHarness();
  for (const { method, path } of everyRequest(harness)) {
    const response = await fetch(`${harness.base}${path}`, {
      method,
      headers: { host: "evil.example" },
      body: method === "GET" ? undefined : "{}",
    });
    expect(response.status, `${method} ${path}`).toBe(403);
    await expectCodedError(response, `${method} ${path}`);
  }
});

test("a body that is not JSON is an invalid body on every route that reads one", async () => {
  harness = openHarness();
  for (const path of ["/api/settings/port", "/api/settings/lan"]) {
    const response = await fetch(`${harness.base}${path}`, { method: "PUT", body: "nope" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "api.invalid_body", data: {} } });
  }
  harness.settings.set("lan.enabled", true);
  harness.settings.set("lan.passphraseHash", await Bun.password.hash("whatever it is", "argon2id"));
  const login = await fetch(`${harness.base}/api/auth/login`, { method: "POST", body: "nope" });
  expect(login.status).toBe(400);
  expect(await login.json()).toEqual({ error: { code: "api.invalid_body", data: {} } });
});

test("a handler that throws gives a coded 500 and the details go to the log only", async () => {
  harness = openHarness();
  const explode: RouteHandler = () => {
    throw new Error("secret detail: the database is on fire");
  };
  const routes = createRoutes(harness.ctx, { "/api/boom": { GET: explode } });
  const listener = listen({ hostname: "127.0.0.1", port: 0, routes, fetch: fallbackFetch() });
  try {
    const response = await fetch(`http://127.0.0.1:${listener.port}/api/boom`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(JSON.stringify({ error: { code: "server.internal_error", data: {} } }));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(harness.logs.join("\n")).toContain("the database is on fire");
  } finally {
    await listener.stop();
  }
});

test("a handler that rejects gives a coded 500 too", async () => {
  harness = openHarness();
  const routes = createRoutes(harness.ctx, {
    "/api/boom": { GET: async () => Promise.reject(new Error("late failure")) },
  });
  const listener = listen({ hostname: "127.0.0.1", port: 0, routes, fetch: fallbackFetch() });
  try {
    const response = await fetch(`http://127.0.0.1:${listener.port}/api/boom`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "server.internal_error", data: {} } });
  } finally {
    await listener.stop();
  }
});
