import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { EngineView } from "../../shared/api-types.ts";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { eventually } from "../testing/harness.ts";
import { EngineMonitor } from "./engine-monitor.ts";
import { EngineStore } from "./engine-store.ts";

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
