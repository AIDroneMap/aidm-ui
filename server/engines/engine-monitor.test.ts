import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { EngineView } from "../../shared/api-types.ts";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { eventually } from "../testing/harness.ts";
import { EngineMonitor } from "./engine-monitor.ts";
import { EngineStore } from "./engine-store.ts";
import { TaskClient } from "../task-api/task-client.ts";

let db: Database;
let store: EngineStore;
let fake: FakeTaskApi;
let monitor: EngineMonitor;
let logs: string[];

beforeEach(async () => {
  db = new Database(":memory:", { strict: true });
  applyMigrations(db, migrations);
  store = new EngineStore(db);
  logs = [];
  monitor = new EngineMonitor({ store, intervalMs: 30, log: (line) => logs.push(line) });
  fake = new FakeTaskApi();
  await fake.start();
});

afterEach(async () => {
  await monitor.stop();
  await fake.stop();
  db.close();
});

test("every stored remote engine starts as starting and is ready after its first answer", async () => {
  const { id } = store.addRemote({ name: "A", address: fake.address, token: fake.token });
  expect(monitor.views()[0]?.state).toBe("starting");
  monitor.start();
  await eventually(async () => monitor.views()[0]?.state === "ready");
  expect(monitor.isUsable(id)).toBe(true);
  expect(store.get(id)?.lastState).toBe("ready");
});

test("a switched-off engine is not polled and keeps its last state", async () => {
  const { id } = store.addRemote({ name: "A", address: fake.address, token: fake.token });
  store.setLastState(id, "ready");
  store.update(id, { enabled: false });
  monitor.start();
  await Bun.sleep(150);
  expect(fake.requests).toEqual([]);
  expect(monitor.views()[0]).toMatchObject({ enabled: false, state: "ready" });
  expect(monitor.isUsable(id)).toBe(false);
});

test("listeners hear about a change once and stop hearing after they unsubscribe", async () => {
  store.addRemote({ name: "A", address: fake.address, token: fake.token });
  const heard: EngineView[][] = [];
  const unsubscribe = monitor.subscribe((views) => heard.push(views));
  monitor.start();
  await eventually(async () => heard.some((views) => views[0]?.state === "ready"));
  const count = heard.length;
  await Bun.sleep(150);
  expect(heard.length).toBe(count);
  unsubscribe();
  fake.info.taskQueueCount = 1;
  await eventually(async () => monitor.views()[0]?.state === "busy");
  expect(heard.length).toBe(count);
});

test("after stop nothing polls and the database may close", async () => {
  store.addRemote({ name: "A", address: fake.address, token: fake.token });
  monitor.start();
  await eventually(async () => fake.requests.length > 0);
  await monitor.stop();
  const count = fake.requests.length;
  await Bun.sleep(150);
  expect(fake.requests.length).toBeLessThanOrEqual(count + 1);
});

test("a view holds no token", async () => {
  fake.token = "SECRET-TOKEN-123";
  store.addRemote({ name: "A", address: fake.address, token: "SECRET-TOKEN-123" });
  monitor.start();
  await eventually(async () => monitor.views()[0]?.state === "ready");
  expect(JSON.stringify(monitor.views())).not.toContain("SECRET-TOKEN-123");
});

/** A monitor whose engine has a name that only this test can resolve; the calls go to the fake. */
function monitorForName(resolve: () => Promise<string[]>): EngineMonitor {
  return new EngineMonitor({
    store,
    intervalMs: 30,
    log: (line) => logs.push(line),
    resolve,
    clientFor: (_endpoint, options) => new TaskClient({ address: fake.address, token: fake.token }, options),
  });
}

test("a plain http name is checked again before every call, and a name that left the network is not called", async () => {
  let resolved = ["10.0.0.5"];
  await monitor.stop();
  monitor = monitorForName(async () => resolved);
  const { id } = store.addRemote({ name: "A", address: "http://engine.example:3000", token: fake.token });
  monitor.start();
  await eventually(async () => monitor.views()[0]?.state === "ready");

  resolved = ["8.8.8.8"];
  await eventually(async () => monitor.views()[0]?.problem?.code === "engine.https_required");
  const count = fake.requests.length;
  await eventually(async () => monitor.views()[0]?.state === "unreachable");
  await Bun.sleep(100);
  expect(fake.requests.length).toBe(count);
  expect(monitor.views()[0]?.problem).toEqual({ code: "engine.https_required", data: {} });
  expect(monitor.isUsable(id)).toBe(false);

  resolved = ["10.0.0.5"];
  await eventually(async () => monitor.views()[0]?.state === "ready");
  expect(monitor.views()[0]?.problem).toBeNull();
});

test("a plain http name that no longer resolves is shown as unreachable and not called", async () => {
  let works = true;
  await monitor.stop();
  monitor = monitorForName(async () => {
    if (works) return ["10.0.0.5"];
    throw new Error("ENOTFOUND");
  });
  store.addRemote({ name: "A", address: "http://engine.example:3000", token: fake.token });
  monitor.start();
  await eventually(async () => monitor.views()[0]?.state === "ready");
  works = false;
  await eventually(async () => monitor.views()[0]?.problem?.code === "engine.unreachable");
  const count = fake.requests.length;
  await Bun.sleep(100);
  expect(fake.requests.length).toBe(count);
});

test("an unknown value is logged once however many polls see it, and again when it changes", async () => {
  fake.info.taskQueueCount = "lots";
  store.addRemote({ name: "A", address: fake.address, token: fake.token });
  monitor.start();
  await eventually(async () => fake.requests.length >= 4);
  const lines = () => logs.filter((line) => line.includes("taskQueueCount"));
  expect(lines()).toEqual(['Engine info field taskQueueCount has an unknown value: "lots"']);

  fake.info.taskQueueCount = "many";
  await eventually(async () => lines().length === 2);
  const count = fake.requests.length;
  await eventually(async () => fake.requests.length >= count + 3);
  expect(lines()).toHaveLength(2);
});

test("a version nobody can read is logged once and the engine is not supported", async () => {
  fake.info.version = "banana";
  store.addRemote({ name: "A", address: fake.address, token: fake.token });
  monitor.start();
  await eventually(async () => fake.requests.length >= 4);
  expect(logs.filter((line) => line.includes("version"))).toEqual(['Engine info field version has an unknown value: "banana"']);
  expect(monitor.views()[0]?.supported).toBe(false);
});

test("stop waits for a poll that is still on its way", async () => {
  fake.infoDelayMs = 300;
  let answered = false;
  await monitor.stop();
  class Probe extends TaskClient {
    override async info() {
      const result = await super.info();
      answered = true;
      return result;
    }
  }
  monitor = new EngineMonitor({
    store,
    intervalMs: 1000,
    log: (line) => logs.push(line),
    clientFor: (endpoint, options) => new Probe(endpoint, options),
  });
  store.addRemote({ name: "A", address: fake.address, token: fake.token });
  monitor.start();
  await eventually(async () => fake.requests.length > 0);
  expect(answered).toBe(false);
  await monitor.stop();
  expect(answered).toBe(true);
});
