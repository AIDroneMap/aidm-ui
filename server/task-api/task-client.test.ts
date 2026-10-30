import { afterEach, expect, test } from "bun:test";
import { FakeTaskApi, WRONG_TOKEN_MESSAGE } from "../../test-support/fake-task-api.ts";
import { isTaskNotFound, TaskClient } from "./task-client.ts";
import { problemFromFailure } from "../engines/problems.ts";

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

test("the option list preserves the engine's facts and scrubs echoed tokens", async () => {
  const api = await startFake({ token: "private-option-token" });
  api.options = [{ name: "dsm", type: "bool", value: "false", domain: "", help: `Engine help ${api.token}`, extra: api.token }] as unknown as typeof api.options;
  expect(await clientFor(api).options()).toEqual({
    ok: true,
    value: [{ name: "dsm", type: "bool", value: "false", domain: "", help: "Engine help ***" }],
  });
  expect(api.requests).toContainEqual({ method: "GET", path: "/options", token: api.token });
});

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
      maxImages: null,
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

// The task calls of ticket #6.

function jpg(text: string): Blob {
  return new Blob([text], { type: "image/jpeg" });
}

test("a task goes through init, upload, commit and info, with the token on every call", async () => {
  const api = await startFake();
  const client = clientFor(api);
  const created = await client.createTask("Sample job", [{ name: "dsm", value: true }]);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const { uuid } = created.value;
  expect(api.tasks.get(uuid)).toMatchObject({ name: "Sample job", options: [{ name: "dsm", value: true }] });

  expect(await client.uploadImage(uuid, "a.JPG", jpg("12345"))).toEqual({ ok: true, value: undefined });
  expect(api.uploads).toEqual([{ uuid, fileName: "a.JPG", size: 5 }]);
  expect(await client.commitTask(uuid)).toEqual({ ok: true, value: undefined });

  const info = await client.taskInfo(uuid);
  expect(info).toEqual({
    ok: true,
    value: { uuid, statusCode: 10, errorMessage: null, progress: 0, processingTime: -1, imagesCount: 1 },
  });
  expect(api.requests.every((request) => request.token === api.token)).toBe(true);
});

test("the engine's refusals come back as the engine's own text", async () => {
  const api = await startFake();
  const client = clientFor(api);
  const unknown = "00000000-0000-4000-8000-0000000000ff";
  const cases = [
    await client.taskInfo(unknown),
    await client.commitTask(unknown),
    await client.uploadImage(unknown, "a.JPG", jpg("1")),
    await client.cancelTask(unknown),
    await client.removeTask(unknown),
    await client.downloadResults(unknown),
  ];
  for (const result of cases) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("engine_error");
  }
  const cancel = await client.cancelTask(unknown);
  expect(cancel).toEqual({ ok: false, failure: { kind: "engine_error", message: `${unknown} not found` } });
});

test("committing twice is the engine's error", async () => {
  const api = await startFake();
  const client = clientFor(api);
  const created = await client.createTask("t", []);
  if (!created.ok) throw new Error("init failed");
  await client.uploadImage(created.value.uuid, "a.JPG", jpg("1"));
  expect((await client.commitTask(created.value.uuid)).ok).toBe(true);
  expect(await client.commitTask(created.value.uuid)).toEqual({
    ok: false,
    failure: { kind: "engine_error", message: "Invalid uuid (not found)" },
  });
});

test("output is read from the line asked for", async () => {
  const api = await startFake();
  const client = clientFor(api);
  const created = await client.createTask("t", []);
  if (!created.ok) throw new Error("init failed");
  api.setTask(created.value.uuid, { output: ["one", "two", "three"] });
  expect(await client.taskOutput(created.value.uuid, 0)).toEqual({ ok: true, value: ["one", "two", "three"] });
  expect(await client.taskOutput(created.value.uuid, 2)).toEqual({ ok: true, value: ["three"] });
  expect(await client.taskOutput(created.value.uuid, 3)).toEqual({ ok: true, value: [] });
});

test("an engine message and an unknown status code pass through as data", async () => {
  const api = await startFake();
  const client = clientFor(api);
  const created = await client.createTask("t", []);
  if (!created.ok) throw new Error("init failed");
  api.setTask(created.value.uuid, { statusCode: 99, errorMessage: "Not enough memory", progress: 41.5, processingTime: 9000 });
  expect(await client.taskInfo(created.value.uuid)).toMatchObject({
    ok: true,
    value: { statusCode: 99, errorMessage: "Not enough memory", progress: 41.5, processingTime: 9000 },
  });
});

test("cancel marks the task cancelled and remove deletes it", async () => {
  const api = await startFake();
  const client = clientFor(api);
  const created = await client.createTask("t", []);
  if (!created.ok) throw new Error("init failed");
  const { uuid } = created.value;
  expect((await client.cancelTask(uuid)).ok).toBe(true);
  expect(api.tasks.get(uuid)?.statusCode).toBe(50);
  expect((await client.removeTask(uuid)).ok).toBe(true);
  expect(api.tasks.has(uuid)).toBe(false);
});

test("the results archive is returned as a response to stream, and not before it exists", async () => {
  const api = await startFake();
  const client = clientFor(api);
  const created = await client.createTask("t", []);
  if (!created.ok) throw new Error("init failed");
  const { uuid } = created.value;
  expect(await client.downloadResults(uuid)).toEqual({
    ok: false,
    failure: { kind: "engine_error", message: "Asset not ready" },
  });
  api.setTask(uuid, { results: new Uint8Array([1, 2, 3, 4]) });
  const result = await client.downloadResults(uuid);
  expect(result.ok).toBe(true);
  if (result.ok) expect(new Uint8Array(await result.value.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test("a wrong token on a task call is the engine's error, and the token is in no log line", async () => {
  const api = await startFake({ token: "SECRET-TOKEN-123" });
  const logs: string[] = [];
  const results = [
    await clientFor(api, logs, "wrong").createTask("t", []),
    await clientFor(api, logs, "wrong").taskInfo("x"),
    await clientFor(api, logs, "wrong").downloadResults("x"),
  ];
  for (const result of results) {
    expect(result).toEqual({ ok: false, failure: { kind: "engine_error", message: WRONG_TOKEN_MESSAGE } });
  }
  const address = api.address;
  await api.stop();
  fake = undefined;
  const down = new TaskClient({ address, token: "SECRET-TOKEN-123" }, { log: (line) => logs.push(line) });
  const failures = [await down.createTask("t", []), await down.taskInfo("x"), await down.uploadImage("x", "a.JPG", jpg("1")), await down.downloadResults("x")];
  for (const failure of failures) {
    expect(failure.ok).toBe(false);
    if (!failure.ok) expect(failure.failure.kind).toBe("unreachable");
  }
  expect(JSON.stringify([logs, failures])).not.toContain("SECRET-TOKEN-123");
});

test("a task call does not follow a redirect", async () => {
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ uuid: "x" }) });
  const redirecting = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.redirect(`http://127.0.0.1:${target.port}/task/new/init`, 307),
  });
  try {
    const client = new TaskClient({ address: `http://127.0.0.1:${redirecting.port}`, token: "t" });
    const results = [await client.createTask("t", []), await client.downloadResults("u")];
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe("bad_response");
    }
  } finally {
    await redirecting.stop(true);
    await target.stop(true);
  }
});

test("an answer for a task the engine does not know is recognised, and no other engine error is", async () => {
  const api = await startFake();
  const client = clientFor(api);
  const uuid = "00000000-0000-4000-8000-0000000000aa";
  const info = await client.taskInfo(uuid);
  expect(info).toEqual({ ok: false, failure: { kind: "engine_error", message: `${uuid} not found` } });
  if (!info.ok) expect(isTaskNotFound(info.failure)).toBe(true);
  const cancelled = await client.cancelTask(uuid);
  expect(cancelled.ok === false && isTaskNotFound(cancelled.failure)).toBe(true);

  // The upload route's own wording is a different answer.
  expect(isTaskNotFound({ kind: "engine_error", message: "Invalid uuid (not found)" })).toBe(false);
  expect(isTaskNotFound({ kind: "engine_error", message: WRONG_TOKEN_MESSAGE })).toBe(false);
  expect(isTaskNotFound({ kind: "unreachable", detail: "x not found" })).toBe(false);
});

test("create, commit, cancel and remove stop when the caller's signal is aborted", async () => {
  const api = await startFake();
  const client = clientFor(api);
  const created = await client.createTask("Job", []);
  if (!created.ok) throw new Error("The fake refused a new task.");
  const { uuid } = created.value;
  const requestsBefore = api.requests.length;

  const aborted = AbortSignal.abort();
  const results = [
    await client.createTask("Another", [], aborted),
    await client.commitTask(uuid, aborted),
    await client.cancelTask(uuid, aborted),
    await client.removeTask(uuid, aborted),
  ];
  for (const result of results) expect(result.ok === false && result.failure.kind === "unreachable").toBe(true);
  expect(api.requests.length).toBe(requestsBefore);
  expect(api.tasks.size).toBe(1);
  expect(api.tasks.get(uuid)?.committed).toBe(false);
});

test("a task's output may be several megabytes, while other answers stay capped at one", async () => {
  const api = await startFake();
  const client = clientFor(api);
  const created = await client.createTask("Job", []);
  if (!created.ok) throw new Error("The fake refused a new task.");
  const line = "x".repeat(1000);
  const lines = Array.from({ length: 4000 }, () => line);
  api.setTask(created.value.uuid, { output: lines });
  const output = await client.taskOutput(created.value.uuid, 0);
  expect(output.ok && output.value.length).toBe(4000);

  api.info.engineVersion = "y".repeat(2 * 1024 * 1024);
  const info = await client.info();
  expect(info.ok).toBe(false);
});


test("task creation refuses an option outside the engine domain before init", async () => {
  const api = await startFake();
  api.options = [{ name: "mesh-octree-depth", type: "int", value: "11", domain: "integer: 1 <= x <= 14", help: "Mesh detail" }];
  const result = await clientFor(api).createTask("Run", [{ name: "mesh-octree-depth", value: 15 }]);
  expect(result).toEqual({
    ok: false, failure: { kind: "invalid_options", name: "mesh-octree-depth", reason: "domain" },
  });
  if (result.ok) throw new Error("An invalid option created a task.");
  expect(problemFromFailure(result.failure)).toEqual({ code: "option.invalid_value", data: { name: "mesh-octree-depth" } });
  expect(api.requests.some((request) => request.path === "/task/new/init")).toBe(false);
  expect(api.tasks.size).toBe(0);
});

test("task creation checks types, every documented domain and duplicate names", async () => {
  const api = await startFake();
  const client = clientFor(api);
  const cases: Array<{ type: "int" | "float" | "bool" | "string" | "enum"; domain: string | string[]; good: unknown; bad: unknown }> = [
    { type: "int", domain: "integer", good: 3, bad: 1.5 },
    { type: "int", domain: "positive integer", good: 0, bad: -1 },
    { type: "float", domain: "negative float", good: -0.25, bad: 1 },
    { type: "float", domain: "float", good: 1.25, bad: "1.25" },
    { type: "float", domain: "percent", good: 100, bad: 100.1 },
    { type: "int", domain: "integer: 1 <= x <= 14", good: 14, bad: 15 },
    { type: "float", domain: "float > 0.0", good: 0.1, bad: 0 },
    { type: "float", domain: "float >= 0", good: 0, bad: -0.1 },
    { type: "int", domain: "integer < 4", good: 3, bad: 4 },
    { type: "int", domain: "integer <= 4", good: 4, bad: 5 },
    { type: "bool", domain: "", good: true, bad: "true" },
    { type: "enum", domain: ["a", "b"], good: "b", bad: "c" },
    { type: "string", domain: "json", good: "{\"x\":1}", bad: "invalid" },
    { type: "string", domain: "string", good: "camera", bad: {} },
    { type: "string", domain: "path", good: "photos", bad: null },
  ];
  for (const entry of cases) {
    api.options = [{ name: "setting", type: entry.type, value: entry.type === "bool" ? "false" : "0", domain: entry.domain, help: "" }];
    expect((await client.createTask("Run", [{ name: "setting", value: entry.good }])).ok, JSON.stringify(entry)).toBe(true);
    const before = api.tasks.size;
    const invalid = await client.createTask("Run", [{ name: "setting", value: entry.bad }]);
    expect(invalid.ok, JSON.stringify(entry)).toBe(false);
    if (!invalid.ok) expect(invalid.failure.kind).toBe("invalid_options");
    expect(api.tasks.size).toBe(before);
  }
  api.options = [{ name: "setting", type: "int", value: "0", domain: "integer", help: "" }];
  expect(await client.createTask("Run", [{ name: "setting", value: 1 }, { name: "setting", value: 2 }])).toEqual({
    ok: false, failure: { kind: "invalid_options", name: "setting", reason: "duplicate" },
  });
  expect(await client.createTask("Run", [{ name: "absent", value: true }])).toEqual({
    ok: false, failure: { kind: "invalid_options", name: "absent", reason: "unavailable" },
  });
  api.options[0]!.domain = "new constraint syntax";
  expect(await client.createTask("Run", [{ name: "setting", value: 1 }])).toEqual({
    ok: false, failure: { kind: "invalid_options", name: "setting", reason: "domain" },
  });
});

test("unusable option facts fail closed without creating a task", async () => {
  const api = await startFake();
  const client = clientFor(api);
  const valid = { name: "setting", type: "int", value: "0", domain: "integer", help: "" };
  const broken = [
    { ...valid, type: "new-type" },
    { ...valid, value: "NaN" },
    { ...valid, value: "" },
    { ...valid, value: "1.5" },
    { ...valid, type: "bool", value: "maybe" },
    { ...valid, help: null },
    { ...valid, domain: [{}] },
  ];
  for (const option of broken) {
    api.options = [option] as unknown as typeof api.options;
    expect(await client.createTask("Run", [{ name: "setting", value: 1 }])).toMatchObject({
      ok: false, failure: { kind: "bad_response" },
    });
  }
  api.options = [valid, valid] as typeof api.options;
  expect(await client.options()).toMatchObject({ ok: false, failure: { kind: "bad_response" } });
  expect(api.tasks.size).toBe(0);
});

test("a value accepted locally still relays the engine's own creation error", async () => {
  const api = await startFake();
  api.createError = `Engine rejected this setting ${api.token}`;
  expect(await clientFor(api).createTask("Run", [{ name: "dsm", value: true }])).toEqual({
    ok: false, failure: { kind: "engine_error", message: "Engine rejected this setting ***" },
  });
  expect(api.tasks.size).toBe(0);
});
