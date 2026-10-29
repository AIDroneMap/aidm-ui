import { expect, test } from "bun:test";
import { findBrowserPage } from "./browser-target.ts";

test("DevTools discovery retries a timed-out request and an empty target list", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    requests++;
    if (requests === 1) await Bun.sleep(200);
    if (requests === 2) return Response.json([]);
    return Response.json([{ type: "page", webSocketDebuggerUrl: "ws://fixture" }]);
  } });
  try {
    expect(await findBrowserPage(server.port!, { deadlineMs: 1000, requestTimeoutMs: 50, retryMs: 10 })).toEqual({ type: "page", webSocketDebuggerUrl: "ws://fixture" });
    expect(requests).toBeGreaterThanOrEqual(3);
  } finally { server.stop(true); }
});

test("DevTools discovery fails with its stage and last error at the deadline", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unavailable", { status: 503 }) });
  try {
    await expect(findBrowserPage(server.port!, { deadlineMs: 150, requestTimeoutMs: 50, retryMs: 10 })).rejects.toThrow("DevTools target discovery timed out: HTTP 503");
  } finally { server.stop(true); }
});

test("a stalled DevTools endpoint cannot exceed the discovery deadline", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    await Bun.sleep(1000);
    return Response.json([]);
  } });
  try {
    await expect(findBrowserPage(server.port!, { deadlineMs: 150, requestTimeoutMs: 40, retryMs: 10 })).rejects.toThrow("DevTools target discovery timed out: TimeoutError");
  } finally { server.stop(true); }
});
