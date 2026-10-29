import { afterEach, beforeEach, expect, test } from "bun:test";
import type { EngineTestView, EngineView } from "../../shared/api-types.ts";
import { FakeTaskApi, WRONG_TOKEN_MESSAGE } from "../../test-support/fake-task-api.ts";
import { TaskClient } from "../task-api/task-client.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

let harness: Harness;
let fake: FakeTaskApi;

beforeEach(async () => {
  harness = openHarness({ enginePollMs: 50 });
  fake = new FakeTaskApi();
  await fake.start();
});

afterEach(async () => {
  await fake.stop();
  await harness.stop();
});

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harness.base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function listEngines(): Promise<EngineView[]> {
  return (await (await send("GET", "/api/engines")).json()) as EngineView[];
}

async function addEngine(name = "Office", address = fake.address, token = fake.token): Promise<EngineView> {
  const response = await send("POST", "/api/engines", { name, address, token });
  expect(response.status).toBe(201);
  return (await response.json()) as EngineView;
}

async function stateOf(id: number): Promise<string | undefined> {
  return (await listEngines()).find((engine) => engine.id === id)?.state;
}

/** Reads server-sent events from a response one at a time. */
function eventReader(response: Response) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    /** The next event, or the first one for which the check holds. */
    async next(check: (views: EngineView[]) => boolean = () => true, timeoutMs = 3000): Promise<EngineView[]> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split("\n").find((line) => line.startsWith("data: "));
          if (block.startsWith("event: engines") && data !== undefined) {
            const views = JSON.parse(data.slice("data: ".length)) as EngineView[];
            if (check(views)) return views;
          }
          continue;
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("No matching event in time.");
        const chunk = await Promise.race([
          reader.read(),
          Bun.sleep(left).then(() => "timeout" as const),
        ]);
        if (chunk === "timeout") throw new Error("No matching event in time.");
        if (chunk.done) throw new Error("The stream ended.");
        buffer += decoder.decode(chunk.value);
      }
    },
    close: () => reader.cancel(),
  };
}

test("testing an engine shows its version, cores, memory and queue length and saves nothing", async () => {
  fake.info.taskQueueCount = 2;
  const response = await send("POST", "/api/engines/test", { address: fake.address, token: fake.token });
  expect(response.status).toBe(200);
  const view = (await response.json()) as EngineTestView;
  expect(view.info).toMatchObject({
    version: "2.5.0",
    cpuCores: 24,
    totalMemory: 64895025152,
    availableMemory: 59901734912,
    queueCount: 2,
  });
  expect(view.supported).toBe(true);
  // The fake listens on 127.0.0.1, whose traffic never leaves the computer.
  expect(view.warning).toBeNull();
  expect(await listEngines()).toEqual([]);
});

test("a wrong token shows the engine's own error and is not a success", async () => {
  const response = await send("POST", "/api/engines/test", { address: fake.address, token: "wrong" });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: { code: "engine.error", data: { message: WRONG_TOKEN_MESSAGE } } });
});

test("an engine that does not answer, or answers with something else, is reported as such when tested", async () => {
  const address = fake.address;
  await fake.stop();
  const down = await send("POST", "/api/engines/test", { address, token: "t" });
  expect(down.status).toBe(502);
  expect(await down.json()).toEqual({ error: { code: "engine.unreachable", data: {} } });

  const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<html></html>") });
  try {
    const odd = await send("POST", "/api/engines/test", { address: `http://127.0.0.1:${other.port}`, token: "t" });
    expect(odd.status).toBe(502);
    expect(await odd.json()).toEqual({ error: { code: "engine.bad_response", data: {} } });
  } finally {
    await other.stop(true);
  }
});

test("an address that breaks the rule is refused when tested and when saved", async () => {
  const cases: Array<[string, string]> = [
    ["http://8.8.8.8:3000", "engine.https_required"],
    ["ftp://192.168.1.5", "engine.address_invalid"],
    ["", "engine.address_invalid"],
  ];
  for (const [address, code] of cases) {
    const tested = await send("POST", "/api/engines/test", { address, token: "t" });
    expect(tested.status, address).toBe(400);
    expect(await tested.json()).toEqual({ error: { code, data: {} } });
    const saved = await send("POST", "/api/engines", { name: "X", address, token: "t" });
    expect(saved.status, address).toBe(400);
    expect(await saved.json()).toEqual({ error: { code, data: {} } });
  }
  expect(await listEngines()).toEqual([]);
});

test("an engine with an unusable version is listed as unsupported and is not used", async () => {
  fake.info.version = "2.4.0";
  const added = await addEngine();
  expect(added.supported).toBe(false);
  expect(added.problem).toEqual({ code: "engine.unsupported_version", data: { version: "2.4.0", minimum: "2.5.0" } });
  expect(harness.engines.isUsable(added.id)).toBe(false);

  fake.info.version = "2.5.0";
  await eventually(async () => (await listEngines())[0]?.supported === true);
  expect(harness.engines.isUsable(added.id)).toBe(true);
  expect((await listEngines())[0]?.problem).toBeNull();
});

test("testing an engine with an old version succeeds and says it is unsupported", async () => {
  fake.info.version = "2.4.0";
  const view = (await (await send("POST", "/api/engines/test", { address: fake.address, token: fake.token })).json()) as EngineTestView;
  expect(view.supported).toBe(false);
  expect(view.info.version).toBe("2.4.0");
});

test("saving does not need the engine to answer, and it becomes unreachable after a few polls", async () => {
  const address = fake.address;
  await fake.stop();
  const added = await addEngine("Barn", address);
  expect(added.state).toBe("starting");
  await eventually(async () => (await stateOf(added.id)) === "unreachable");
  expect(harness.engines.isUsable(added.id)).toBe(false);
});

test("a saved engine on this computer appears as ready with its details and no plain http warning", async () => {
  const added = await addEngine();
  expect(added).toMatchObject({ kind: "remote", name: "Office", address: fake.address, enabled: true, state: "ready", supported: true });
  expect(added.info?.cpuCores).toBe(24);
  expect(added.warning).toBeNull();
  expect(harness.engineStore.get(added.id)?.lastState).toBe("ready");
});

test("an engine with a queue is busy", async () => {
  fake.info.taskQueueCount = 4;
  const added = await addEngine();
  expect(added.state).toBe("busy");
  expect(added.info?.queueCount).toBe(4);
});

test("a wrong token on a saved engine makes it failed with the engine's message", async () => {
  const added = await addEngine("Office", fake.address, "wrong");
  expect(added.state).toBe("failed");
  expect(added.problem).toEqual({ code: "engine.error", data: { message: WRONG_TOKEN_MESSAGE } });
  expect(added.info).toBeNull();
});

test("an engine needs a name", async () => {
  for (const name of ["", "   "]) {
    const response = await send("POST", "/api/engines", { name, address: fake.address, token: "t" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "engine.name_required", data: {} } });
  }
  const response = await send("POST", "/api/engines", { name: 5, address: fake.address, token: "t" });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "api.invalid_body", data: {} } });
  expect((await addEngine("  Padded  ")).name).toBe("Padded");
});

test("stopping the engine moves it to unreachable on the open stream and starting it moves it back to ready", async () => {
  const added = await addEngine();
  const response = await send("GET", "/api/engines/events");
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const events = eventReader(response);
  try {
    const first = await events.next();
    expect(first.find((engine) => engine.id === added.id)?.state).toBe("ready");

    await fake.stop();
    await events.next((views) => views.find((engine) => engine.id === added.id)?.state === "unreachable");

    await fake.restart();
    await events.next((views) => views.find((engine) => engine.id === added.id)?.state === "ready");
  } finally {
    await events.close();
  }
});

test("an unknown value from the engine is logged with its raw value and the poll goes on", async () => {
  fake.info.taskQueueCount = "lots";
  fake.info.cpuCores = {};
  const added = await addEngine();
  expect(added.state).toBe("ready");
  expect(added.info?.queueCount).toBeNull();
  expect(added.info?.cpuCores).toBeNull();
  expect(harness.logs).toContain('Engine info field taskQueueCount has an unknown value: "lots"');
  expect(harness.logs).toContain("Engine info field cpuCores has an unknown value: {}");

  fake.info.taskQueueCount = 1;
  await eventually(async () => (await stateOf(added.id)) === "busy");
});

test("an engine can be renamed, given a new address and token, and switched off and on", async () => {
  const added = await addEngine();

  const renamed = await send("PUT", `/api/engines/${added.id}`, { name: "Shed" });
  expect(renamed.status).toBe(200);
  expect(((await renamed.json()) as EngineView).name).toBe("Shed");
  expect(harness.engineStore.get(added.id)?.token).toBe(fake.token);

  const other = new FakeTaskApi({ token: "other-token", info: { cpuCores: 4 } });
  await other.start();
  try {
    const moved = await send("PUT", `/api/engines/${added.id}`, { address: `${other.address}/`, token: "other-token" });
    expect(moved.status).toBe(200);
    const movedView = (await moved.json()) as EngineView;
    expect(movedView.address).toBe(other.address);
    expect(movedView.info?.cpuCores).toBe(4);
    expect(movedView.state).toBe("ready");

    const off = (await (await send("PUT", `/api/engines/${added.id}`, { enabled: false })).json()) as EngineView;
    expect(off.enabled).toBe(false);
    expect(off.state).toBe("ready");
    const requestsWhenOff = other.requests.length;
    await Bun.sleep(250);
    expect(other.requests.length).toBe(requestsWhenOff);

    const on = (await (await send("PUT", `/api/engines/${added.id}`, { enabled: true })).json()) as EngineView;
    expect(on.enabled).toBe(true);
    expect(other.requests.length).toBeGreaterThan(requestsWhenOff);
  } finally {
    await other.stop();
  }
});

test("a new address needs the token typed again, and the same address does not", async () => {
  const added = await addEngine();
  const other = new FakeTaskApi({ token: "other-token" });
  await other.start();
  try {
    const refused = await send("PUT", `/api/engines/${added.id}`, { address: other.address });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: { code: "engine.token_required", data: {} } });
    expect(harness.engineStore.get(added.id)).toMatchObject({ address: fake.address, token: fake.token });

    const same = await send("PUT", `/api/engines/${added.id}`, { address: `${fake.address}/`, name: "Same" });
    expect(same.status).toBe(200);

    const moved = await send("PUT", `/api/engines/${added.id}`, { address: other.address, token: "other-token" });
    expect(moved.status).toBe(200);
  } finally {
    await other.stop();
  }
});

test("an engine removed while an add waits for its first answer is not found", async () => {
  fake.infoDelayMs = 300;
  const adding = send("POST", "/api/engines", { name: "Office", address: fake.address, token: fake.token });
  await eventually(async () => harness.engineStore.list().length === 1);
  const id = harness.engineStore.list()[0]?.id;
  await send("DELETE", `/api/engines/${id}`);
  const response = await adding;
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: { code: "engine.not_found", data: {} } });
});

test("an engine removed while an edit waits for its first answer is not found", async () => {
  const added = await addEngine();
  fake.infoDelayMs = 300;
  const editing = send("PUT", `/api/engines/${added.id}`, { token: fake.token, name: "Shed" });
  await eventually(async () => harness.engineStore.get(added.id)?.name === "Shed");
  await send("DELETE", `/api/engines/${added.id}`);
  const response = await editing;
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: { code: "engine.not_found", data: {} } });
});

test("a plain http name that leaves the network is refused by the page too", async () => {
  await harness.stop();
  let resolved = ["10.0.0.5"];
  harness = openHarness({
    enginePollMs: 50,
    resolve: async () => resolved,
    clientFor: (_endpoint, options) => new TaskClient({ address: fake.address, token: fake.token }, options),
  });
  const added = await addEngine("Named", "http://engine.example:3000");
  expect(added.state).toBe("ready");
  resolved = ["8.8.8.8"];
  await eventually(async () => (await listEngines())[0]?.problem?.code === "engine.https_required");
  const count = fake.requests.length;
  await Bun.sleep(150);
  expect(fake.requests.length).toBe(count);
  const again = await send("POST", "/api/engines", { name: "Two", address: "http://engine.example:3000", token: "t" });
  expect(again.status).toBe(400);
  expect(await again.json()).toEqual({ error: { code: "engine.https_required", data: {} } });
});

test("an edit with a bad address or name changes nothing", async () => {
  const added = await addEngine();
  const badAddress = await send("PUT", `/api/engines/${added.id}`, { name: "Changed", address: "http://8.8.8.8:3000" });
  expect(badAddress.status).toBe(400);
  expect(await badAddress.json()).toEqual({ error: { code: "engine.https_required", data: {} } });
  const badName = await send("PUT", `/api/engines/${added.id}`, { name: " " });
  expect(badName.status).toBe(400);
  expect(await badName.json()).toEqual({ error: { code: "engine.name_required", data: {} } });
  const badType = await send("PUT", `/api/engines/${added.id}`, { enabled: "yes" });
  expect(badType.status).toBe(400);
  expect(harness.engineStore.get(added.id)).toMatchObject({ name: "Office", address: fake.address });
});

test("an engine can be removed, and an unknown one is not found", async () => {
  const added = await addEngine();
  const removed = await send("DELETE", `/api/engines/${added.id}`);
  expect(removed.status).toBe(204);
  expect(await listEngines()).toEqual([]);

  for (const [method, id] of [["DELETE", added.id], ["PUT", added.id], ["PUT", "abc"], ["DELETE", "1.5"]] as const) {
    const response = await send(method, `/api/engines/${id}`, method === "PUT" ? {} : undefined);
    expect(response.status, `${method} ${id}`).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "engine.not_found", data: {} } });
  }
});

test("a removed engine is no longer polled", async () => {
  const added = await addEngine();
  await send("DELETE", `/api/engines/${added.id}`);
  const count = fake.requests.length;
  await Bun.sleep(250);
  expect(fake.requests.length).toBe(count);
});

test("the token never appears in anything sent to the browser or written to the log", async () => {
  const token = "SECRET-TOKEN-123";
  fake.token = token;
  const bodies: string[] = [];
  const keep = async (response: Response) => {
    bodies.push(`${response.status} ${JSON.stringify([...response.headers])} ${await response.text()}`);
  };

  await keep(await send("POST", "/api/engines/test", { address: fake.address, token }));
  await keep(await send("POST", "/api/engines/test", { address: fake.address, token: `${token}-wrong` }));
  const addResponse = await send("POST", "/api/engines", { name: "Office", address: fake.address, token });
  const added = (await addResponse.clone().json()) as EngineView;
  await keep(addResponse);
  await keep(await send("GET", "/api/engines"));
  await keep(await send("PUT", `/api/engines/${added.id}`, { name: "Renamed", token }));
  await keep(await send("PUT", `/api/engines/${added.id}`, { address: "http://8.8.8.8:1", token }));
  await keep(await send("POST", "/api/engines", { name: "", address: fake.address, token }));

  const events = eventReader(await send("GET", "/api/engines/events"));
  try {
    const views = await events.next();
    bodies.push(JSON.stringify(views));
  } finally {
    await events.close();
  }

  // Failures that put the address and the token through the log.
  await fake.stop();
  await send("POST", "/api/engines/test", { address: fake.address, token });
  await eventually(async () => (await stateOf(added.id)) === "unreachable");
  await fake.restart();
  fake.info.cpuCores = "token is " + token;
  await eventually(async () => harness.logs.some((line) => line.includes("cpuCores")));

  expect(bodies.length).toBeGreaterThanOrEqual(8);
  for (const body of bodies) expect(body).not.toContain(token);
  // The only line allowed to hold it is the one repeating what the engine itself sent, which is scrubbed.
  for (const line of harness.logs) expect(line).not.toContain(token);
  expect(harness.engineStore.get(added.id)?.token).toBe(token);
});


test("engine options reconcile facts, hide internal names and keep unknown options last", async () => {
  fake.options = [
    { name: "new-engine-option", type: "float", value: "2.5", domain: "positive float", help: "Engine explanation" },
    { name: "end-with", type: "string", value: "report", domain: "string", help: "Hidden" },
    { name: "dsm", type: "bool", value: "true", domain: "", help: "Surface" },
    { name: "orthophoto-resolution", type: "int", value: "1", domain: "integer >= 1", help: "Resolution" },
    { name: "rerun-from", type: "string", value: "dataset", domain: "string", help: "Hidden" },
    { name: "gcp", type: "string", value: "", domain: "path", help: "Hidden" },
    { name: "split", type: "int", value: "0", domain: "positive integer", help: "Hidden" },
    { name: "tiles", type: "bool", value: "false", domain: "", help: "Hidden" },
  ];
  const engine = await addEngine();
  const response = await send("GET", `/api/engines/${engine.id}/options`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.options.map((option: { name: string }) => option.name)).toEqual(["dsm", "orthophoto-resolution", "new-engine-option"]);
  expect(body.options[0]).toMatchObject({ name: "dsm", defaultValue: true, unexplained: false, changes: ["defaultValue"] });
  expect(body.options[1]).toMatchObject({ type: "int", domain: "integer >= 1", defaultValue: 1, changes: ["type", "domain", "defaultValue"] });
  expect(body.options[2]).toMatchObject({ group: "unexplained", defaultValue: 2.5, unexplained: true, help: "Engine explanation" });
  fake.options = [{ name: "dtm", type: "bool", value: "false", domain: "", help: "Ground" }];
  const refreshed = await (await send("GET", `/api/engines/${engine.id}/options`)).json();
  expect(refreshed.options.map((option: { name: string }) => option.name)).toEqual(["dtm"]);
});

test("the 2.6.1 compatibility baseline detects new and missing options through the route", async () => {
  const { assertCatalogueDrift } = await import("../../test-support/catalogue-drift.ts");
  fake.info.version = "2.6.1";
  const engine = await addEngine();
  const options = async () => (await (await send("GET", `/api/engines/${engine.id}/options`)).json()).options;
  expect(() => assertCatalogueDrift([], "2.6.1")).toThrow("Catalogue drift");
  expect(() => assertCatalogueDrift([], "2.6.2")).toThrow("Catalogue drift");
  const baseline = await options();
  expect(() => assertCatalogueDrift(baseline, "2.6.1")).not.toThrow();
  expect(() => assertCatalogueDrift(baseline, "2.6.2")).toThrow("Catalogue drift");
  fake.options.push({ name: "brand-new-option", type: "bool", value: "false", domain: "", help: "New help" });
  const added = await options();
  expect(() => assertCatalogueDrift(added, "2.6.1")).toThrow("brand-new-option");
  fake.options = fake.options.filter((option) => option.name !== "brand-new-option" && option.name !== "dsm");
  const missing = await options();
  expect(() => assertCatalogueDrift(missing, "2.6.1")).toThrow("dsm");
});
