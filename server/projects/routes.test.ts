import { afterEach, beforeEach, expect, test } from "bun:test";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { TaskClient } from "../task-api/task-client.ts";
import type { ProjectView } from "../../shared/api-types.ts";

let harness: Harness;
beforeEach(() => { harness = openHarness(); });
afterEach(async () => { await harness.stop(); });
function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harness.base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

test("project routes validate, create, read, edit and delete metadata", async () => {
  expect((await send("POST", "/api/projects", { name: "  ", notes: "" })).status).toBe(400);
  expect((await send("POST", "/api/projects", { name: "Test", notes: 4 })).status).toBe(400);
  const created = await send("POST", "/api/projects", { name: " Survey ", notes: "Field" });
  expect(created.status).toBe(201);
  const project = await created.json() as ProjectView;
  expect(project).toMatchObject({ name: "Survey", notes: "Field", photoCount: 0, runCount: 0 });
  expect(await (await send("GET", "/api/projects")).json()).toEqual([project]);
  const path = `/api/projects/${project.id}`;
  expect(await (await send("GET", path)).json()).toEqual(project);
  expect((await send("PUT", path, { name: "", notes: "" })).status).toBe(400);
  expect(await (await send("PUT", path, { name: "Renamed", notes: "Notes" })).json()).toMatchObject({ name: "Renamed", notes: "Notes" });
  expect((await send("DELETE", path)).status).toBe(204);
  expect((await send("GET", path)).status).toBe(404);
  expect((await send("DELETE", path)).status).toBe(404);
});

test("a task with no recorded engine reports incomplete deletion and keeps its run", async () => {
  const project = await (await send("POST", "/api/projects", { name: "Lost engine", notes: "" })).json() as ProjectView;
  const engine = harness.engineStore.addRemote({ name: "Engine", address: "http://127.0.0.1:1", token: "token" });
  const run = harness.runs.create({ projectId: project.id, engineId: engine.id, options: [] });
  harness.runs.update(run.id, { taskUuid: "task-1", state: "failed" });
  harness.engineStore.remove(engine.id);
  const response = await send("DELETE", `/api/projects/${project.id}`);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: { code: "project.deletion_engine_missing", data: {} } });
  expect(harness.runs.get(run.id)).not.toBeNull();
  expect((await send("GET", `/api/projects/${project.id}`)).status).toBe(200);
});


test("deletion removes tasks on every engine and owned files, but leaves imported files alone", async () => {
  const first = new FakeTaskApi();
  const second = new FakeTaskApi();
  await first.start(); await second.start();
  const outside = await mkdtemp(join(tmpdir(), "imported-"));
  try {
    const project = await (await send("POST", "/api/projects", { name: "Survey", notes: "" })).json() as ProjectView;
    const ids: number[] = [];
    for (const fake of [first, second]) {
      const engine = harness.engineStore.addRemote({ name: "Engine", address: fake.address, token: fake.token });
      const task = await new TaskClient({ address: fake.address, token: fake.token }).createTask("test", []);
      if (!task.ok) throw new Error("Task creation failed");
      const run = harness.runs.create({ projectId: project.id, engineId: engine.id, options: [] });
      ids.push(run.id);
      harness.runs.update(run.id, { taskUuid: task.value.uuid, state: "queued" });
      await mkdir(join(harness.dataFolder, "runs", String(run.id)), { recursive: true });
      await writeFile(join(harness.dataFolder, "runs", String(run.id), "log.txt"), "log");
    }
    const owned = join(harness.dataFolder, "projects", String(project.id), "runs", String(ids[0]));
    await mkdir(owned, { recursive: true });
    await writeFile(join(owned, "archive.zip"), "archive");
    await writeFile(join(outside, "sentinel"), "untouched");
    expect((await send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    expect(first.tasks.size).toBe(0); expect(second.tasks.size).toBe(0);
    expect(await Bun.file(join(owned, "archive.zip")).exists()).toBe(false);
    expect(await Bun.file(join(harness.dataFolder, "runs", String(ids[0]), "log.txt")).exists()).toBe(false);
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("untouched");
    expect(harness.runs.get(ids[0]!)).toBeNull();
  } finally { await first.stop(); await second.stop(); await rm(outside, { recursive: true, force: true }); }
});

test("failure preserves files and rows, and retry accepts a task already removed", async () => {
  const first = new FakeTaskApi(); const second = new FakeTaskApi();
  await first.start(); await second.start();
  try {
    const project = await (await send("POST", "/api/projects", { name: "Retry", notes: "" })).json() as ProjectView;
    const runs: number[] = [];
    let secondEngine = 0;
    for (const [fake, token] of [[first, first.token], [second, "wrong"]] as const) {
      const engine = harness.engineStore.addRemote({ name: "Engine", address: fake.address, token });
      secondEngine = engine.id;
      const task = await new TaskClient({ address: fake.address, token: fake.token }).createTask("test", []);
      if (!task.ok) throw new Error("Task creation failed");
      const run = harness.runs.create({ projectId: project.id, engineId: engine.id, options: [] });
      runs.push(run.id);
      harness.runs.update(run.id, { taskUuid: task.value.uuid, state: "failed" });
    }
    const archive = join(harness.dataFolder, "projects", String(project.id), "archive.zip");
    await mkdir(join(harness.dataFolder, "projects", String(project.id)), { recursive: true });
    await writeFile(archive, "archive");
    const failed = await send("DELETE", `/api/projects/${project.id}`);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: { code: "project.deletion_incomplete", data: {} } });
    expect(first.tasks.size).toBe(0); expect(second.tasks.size).toBe(1);
    expect(await Bun.file(archive).exists()).toBe(true);
    expect(harness.runs.get(runs[0]!)).not.toBeNull();
    expect(harness.runs.get(runs[1]!)).not.toBeNull();
    harness.engineStore.update(secondEngine, { token: second.token });
    expect((await send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    expect(second.tasks.size).toBe(0);
    expect(await Bun.file(archive).exists()).toBe(false);
  } finally { await first.stop(); await second.stop(); }
});

test("a sample run cannot start while its project is being deleted", async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const engineServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    started(); await waiting; return Response.json({ success: true });
  } });
  try {
    const engine = harness.engineStore.addRemote({ name: "Engine", address: `http://127.0.0.1:${engineServer.port}`, token: "token" });
    const sampleId = harness.runs.builtinProjectId("sample")!;
    const run = harness.runs.create({ projectId: sampleId, engineId: engine.id, options: [] });
    harness.runs.update(run.id, { taskUuid: "sample-task", state: "failed" });
    const deleting = send("DELETE", `/api/projects/${sampleId}`);
    await entered;
    const starting = await send("POST", "/api/sample/start", { engineId: engine.id });
    expect(starting.status).toBe(409);
    expect(await starting.json()).toEqual({ error: { code: "project.deletion_busy", data: {} } });
    release();
    expect((await deleting).status).toBe(204);
  } finally { release(); await engineServer.stop(true); }
});

test("an unreachable engine leaves the project available for retry", async () => {
  const fake = new FakeTaskApi(); await fake.start();
  try {
    const project = await (await send("POST", "/api/projects", { name: "Offline", notes: "" })).json() as ProjectView;
    const engine = harness.engineStore.addRemote({ name: "Engine", address: fake.address, token: fake.token });
    const task = await new TaskClient({ address: fake.address, token: fake.token }).createTask("test", []);
    if (!task.ok) throw new Error("Task creation failed");
    const run = harness.runs.create({ projectId: project.id, engineId: engine.id, options: [] });
    harness.runs.update(run.id, { taskUuid: task.value.uuid, state: "completed" });
    await fake.stop();
    expect((await send("DELETE", `/api/projects/${project.id}`)).status).toBe(502);
    expect(harness.runs.get(run.id)).not.toBeNull();
    expect((await send("GET", `/api/projects/${project.id}`)).status).toBe(200);
    await fake.restart();
    expect((await send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
  } finally { await fake.stop(); }
});


test("a run after project deletion keeps the first lines already on its engine", async () => {
  const fake = new FakeTaskApi();
  await fake.start();
  try {
    const engine = harness.engineStore.addRemote({ name: "Engine", address: fake.address, token: fake.token });
    const client = new TaskClient({ address: fake.address, token: fake.token });
    async function followOutput(projectId: number, lines: string[]) {
      const task = await client.createTask("Run", []);
      if (!task.ok) throw new Error("Task creation failed");
      fake.setTask(task.value.uuid, { statusCode: 40, output: lines });
      const run = harness.runs.create({ projectId, engineId: engine.id, options: [] });
      harness.runs.update(run.id, { taskUuid: task.value.uuid, state: "queued" });
      harness.tracker.follow(run.id);
      await eventually(async () => harness.tracker.view(run.id)?.state === "completed");
      return run;
    }
    const first = harness.ctx.projects.create("First flight", "");
    const oldRun = await followOutput(first.id, ["old line"]);
    expect(harness.tracker.log(oldRun.id, 0).lines).toEqual(["old line"]);
    expect((await send("DELETE", `/api/projects/${first.id}`)).status).toBe(204);
    const second = harness.ctx.projects.create("Next flight", "");
    const nextRun = await followOutput(second.id, ["first new line", "second new line"]);
    expect(harness.tracker.log(nextRun.id, 0).lines).toEqual(["first new line", "second new line"]);
    expect(nextRun.id).toBeGreaterThan(oldRun.id);
  } finally { await fake.stop(); }
});
