import { afterEach, expect, test } from "bun:test";
import { ALL_INTERFACES, listen, type Listener } from "./listener.ts";

const open: Array<{ stop(force?: boolean): unknown }> = [];

afterEach(async () => {
  for (const item of open.splice(0)) await item.stop(true);
});

function serve(hostname: string, port = 0): Listener {
  const listener = listen({
    hostname,
    port,
    routes: { "/hello": { GET: async () => new Response("hello") } },
    fetch: () => new Response("fallback"),
  });
  open.push(listener);
  return listener;
}

async function body(url: string): Promise<string | null> {
  try {
    return await (await fetch(url, { signal: AbortSignal.timeout(1000) })).text();
  } catch {
    return null;
  }
}

test("a listener serves its routes on the port it was given", async () => {
  const listener = serve("127.0.0.1");
  expect(listener.hostname).toBe("127.0.0.1");
  expect(await body(`http://127.0.0.1:${listener.port}/hello`)).toBe("hello");
});

test("a port that is taken throws the address-in-use error", () => {
  const first = serve("127.0.0.1");
  expect(() => serve("127.0.0.1", first.port)).toThrow(expect.objectContaining({ code: "EADDRINUSE" }));
});

test("rebinding keeps the port and serves from the new address", async () => {
  const listener = serve("127.0.0.1");
  const { port } = listener;
  await listener.rebind(ALL_INTERFACES);
  expect(listener.hostname).toBe(ALL_INTERFACES);
  expect(listener.port).toBe(port);
  expect(await body(`http://127.0.0.1:${port}/hello`)).toBe("hello");
  await listener.rebind("127.0.0.1");
  expect(await body(`http://127.0.0.1:${port}/hello`)).toBe("hello");
});

test("rebinding to the address it already has changes nothing", async () => {
  const listener = serve("127.0.0.1");
  await listener.rebind("127.0.0.1");
  expect(await body(`http://127.0.0.1:${listener.port}/hello`)).toBe("hello");
});

test.skipIf(process.platform !== "linux")("a rebind that cannot bind leaves the old address serving and reports the error", async () => {
  const listener = serve("127.0.0.1");
  // Another program on the same port at a different loopback address blocks "all interfaces".
  const blocker = Bun.serve({ hostname: "127.0.0.2", port: listener.port, fetch: () => new Response("other") });
  open.push(blocker);

  await expect(listener.rebind(ALL_INTERFACES)).rejects.toThrow();
  expect(listener.hostname).toBe("127.0.0.1");
  expect(await body(`http://127.0.0.1:${listener.port}/hello`)).toBe("hello");
});

test("stopping frees the port, and a rebind after it does nothing", async () => {
  const listener = serve("127.0.0.1");
  const { port } = listener;
  await listener.stop();
  expect(await body(`http://127.0.0.1:${port}/hello`)).toBeNull();
  await listener.rebind(ALL_INTERFACES);
  expect(await body(`http://127.0.0.1:${port}/hello`)).toBeNull();
});
