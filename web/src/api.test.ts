import { afterAll, beforeAll, expect, test } from "bun:test";
import { api, ApiFailure, setApiBase } from "./api.ts";

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/coded") {
        return Response.json({ error: { code: "settings.port_invalid", data: { min: 1, max: 65535 } } }, { status: 400 });
      }
      if (path === "/empty") return new Response(null, { status: 204 });
      if (path === "/crash") return new Response("<html>oops</html>", { status: 500 });
      if (path === "/unknown-code") return Response.json({ error: { code: "made.up" } }, { status: 400 });
      if (path === "/echo") {
        return Response.json({
          method: request.method,
          contentType: request.headers.get("content-type"),
          body: await request.text(),
        });
      }
      return Response.json({ ok: true });
    },
  });
  setApiBase(`http://127.0.0.1:${server.port}`);
});

afterAll(() => {
  server.stop(true);
  setApiBase("");
});

async function failureOf(call: Promise<unknown>): Promise<ApiFailure> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiFailure);
    return error as ApiFailure;
  }
  throw new Error("the call did not fail");
}

test("a coded error keeps its status, code and data", async () => {
  const failure = await failureOf(api("GET", "/coded"));
  expect(failure.status).toBe(400);
  expect(failure.code).toBe("settings.port_invalid");
  expect(failure.data).toEqual({ min: 1, max: 65535 });
});

test("a 204 resolves to undefined", async () => {
  expect(await api("PUT", "/empty", { a: 1 })).toBeUndefined();
});

test("a body that is not JSON becomes server.internal_error", async () => {
  const failure = await failureOf(api("GET", "/crash"));
  expect(failure.status).toBe(500);
  expect(failure.code).toBe("server.internal_error");
});

test("a code the interface does not know becomes server.internal_error", async () => {
  const failure = await failureOf(api("GET", "/unknown-code"));
  expect(failure.code).toBe("server.internal_error");
});

test("a request with a body is sent as JSON", async () => {
  const echoed = await api<{ method: string; contentType: string; body: string }>("PUT", "/echo", { port: 9000 });
  expect(echoed.method).toBe("PUT");
  expect(echoed.contentType).toContain("application/json");
  expect(JSON.parse(echoed.body)).toEqual({ port: 9000 });
});

test("no answer at all becomes network.unreachable", async () => {
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = closed.port;
  closed.stop(true);
  const before = `http://127.0.0.1:${server.port}`;
  setApiBase(`http://127.0.0.1:${port}`);
  try {
    const failure = await failureOf(api("GET", "/anything"));
    expect(failure.code).toBe("network.unreachable");
  } finally {
    setApiBase(before);
  }
});
