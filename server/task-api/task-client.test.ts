import { afterEach, expect, test } from "bun:test";
import { FakeTaskApi, WRONG_TOKEN_MESSAGE } from "../../test-support/fake-task-api.ts";
import { TaskClient } from "./task-client.ts";

let fake: FakeTaskApi | undefined;

afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

async function startFake(options?: ConstructorParameters<typeof FakeTaskApi>[0]): Promise<FakeTaskApi> {
  fake = new FakeTaskApi(options);
  await fake.start();
  return fake;
}

function clientFor(api: FakeTaskApi, logs: string[] = [], token = api.token): TaskClient {
  return new TaskClient({ address: api.address, token }, { log: (line) => logs.push(line), timeoutMs: 2000 });
}

test("info reads the version, cores, memory and queue length", async () => {
  const api = await startFake({ info: { taskQueueCount: 3 } });
  const result = await clientFor(api).info();
  expect(result).toEqual({
    ok: true,
    value: {
      version: "2.5.0",
      engineVersion: "0.1.0",
      cpuCores: 24,
      totalMemory: 64895025152,
      availableMemory: 59901734912,
      queueCount: 3,
      maxParallelTasks: 1,
    },
  });
});

test("the token goes in the query string, encoded", async () => {
  const api = await startFake({ token: "a b&c=d" });
  expect((await clientFor(api).info()).ok).toBe(true);
  expect(api.requests).toEqual([{ method: "GET", path: "/info", token: "a b&c=d" }]);
});

test("an error body with HTTP 200 is the engine's error, not a success", async () => {
  const api = await startFake();
  const result = await clientFor(api, [], "wrong").info();
  expect(result).toEqual({ ok: false, failure: { kind: "engine_error", message: WRONG_TOKEN_MESSAGE } });
});

test("a refused connection is unreachable", async () => {
  const api = await startFake();
  await api.stop();
  const result = await clientFor(api).info();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.kind).toBe("unreachable");
});

test("an answer that takes too long is unreachable", async () => {
  const slow = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
  try {
    const client = new TaskClient({ address: `http://127.0.0.1:${slow.port}`, token: "t" }, { timeoutMs: 100 });
    const result = await client.info();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("unreachable");
  } finally {
    await slow.stop(true);
  }
});

test("a reply that is not JSON, or has another status, is a bad response", async () => {
  const other = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new URL(req.url).pathname === "/info"
        ? new Response("<html>hello</html>")
        : new Response("no", { status: 404 }),
  });
  try {
    const client = new TaskClient({ address: `http://127.0.0.1:${other.port}`, token: "t" });
    const result = await client.info();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("bad_response");
  } finally {
    await other.stop(true);
  }
});

test("a JSON answer with another HTTP status is a bad response", async () => {
  const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ version: "2.5.0" }, { status: 503 }) });
  try {
    const result = await new TaskClient({ address: `http://127.0.0.1:${other.port}`, token: "t" }).info();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("bad_response");
  } finally {
    await other.stop(true);
  }
});

test("a redirect is not followed, so the token goes nowhere else", async () => {
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ version: "2.5.0" }) });
  const redirecting = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.redirect(`http://127.0.0.1:${target.port}/info`, 302),
  });
  try {
    const result = await new TaskClient({ address: `http://127.0.0.1:${redirecting.port}`, token: "t" }).info();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("bad_response");
  } finally {
    await redirecting.stop(true);
    await target.stop(true);
  }
});

test("an answer without a version is a bad response", async () => {
  for (const version of [undefined, "", 2.5, null]) {
    const api = await startFake({ info: { version: version as unknown as string } });
    const result = await clientFor(api).info();
    expect(result.ok, String(version)).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("bad_response");
    await api.stop();
    fake = undefined;
  }
});

test("a field with an unusable value is logged with its raw value and becomes null", async () => {
  const api = await startFake({ info: { taskQueueCount: "lots", cpuCores: {}, totalMemory: -1, maxParallelTasks: 1.5 } });
  const logs: string[] = [];
  const result = await clientFor(api, logs).info();
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.queueCount).toBeNull();
    expect(result.value.cpuCores).toBeNull();
    expect(result.value.totalMemory).toBeNull();
    expect(result.value.maxParallelTasks).toBeNull();
    expect(result.value.availableMemory).toBe(59901734912);
  }
  expect(logs).toContain('Engine info field taskQueueCount has an unknown value: "lots"');
  expect(logs).toContain("Engine info field cpuCores has an unknown value: {}");
  expect(logs).toContain("Engine info field totalMemory has an unknown value: -1");
});

test("fields the engine leaves out are null without a log line, and extra fields are ignored", async () => {
  const api = await startFake({ info: { somethingNew: [1, 2] } });
  delete api.info.engineVersion;
  delete api.info.cpuCores;
  const logs: string[] = [];
  const result = await clientFor(api, logs).info();
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.engineVersion).toBeNull();
    expect(result.value.cpuCores).toBeNull();
  }
  expect(logs).toEqual([]);
});

test("the token appears in no log line and no failure, whatever goes wrong", async () => {
  const token = "SECRET-TOKEN-123";
  const logs: string[] = [];
  const results = [];

  const api = await startFake({ token, info: { taskQueueCount: "lots" } });
  results.push(await clientFor(api, logs).info());
  results.push(await clientFor(api, logs, "wrong").info());
  const address = api.address;
  await api.stop();
  results.push(await new TaskClient({ address, token }, { log: (line) => logs.push(line) }).info());

  // An engine that echoes the token back in its own error text.
  const echo = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => Response.json({ error: `Bad request ${req.url}` }),
  });
  try {
    results.push(await new TaskClient({ address: `http://127.0.0.1:${echo.port}`, token }, { log: (line) => logs.push(line) }).info());
  } finally {
    await echo.stop(true);
  }

  const everything = JSON.stringify([logs, results]);
  expect(everything).not.toContain(token);
  expect(everything).not.toContain(encodeURIComponent(token));
  expect(logs.length).toBeGreaterThan(0);
});
