import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RunView, ProjectView } from "../../shared/api-types.ts";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { TaskClient, type EngineEndpoint } from "../task-api/task-client.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

let h: Harness;
let fake: FakeTaskApi;
const folders: string[] = [];
afterEach(async () => { await h?.stop(); await fake?.stop(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

async function completedRun(dataFolder?: string, runClientFor?: (endpoint: EngineEndpoint) => TaskClient) {
  fake = new FakeTaskApi(); await fake.start();
  h = openHarness({ runPollMs: 20, dataFolder, runClientFor });
  const engine = h.engineStore.addRemote({ name: "Field", address: fake.address, token: fake.token });
  const project = h.ctx.projects.create("Field", "Keep these notes");
  const client = new TaskClient({ address: fake.address, token: fake.token });
  const task = await client.createTask("Field", []);
  if (!task.ok) throw new Error("Task creation failed");
  const archive = join(h.dataFolder, "fixture.zip");
  writeStoredZip(archive, [
    { name: "odm_orthophoto/odm_orthophoto.tif", data: new TextEncoder().encode("tiff bytes") },
    { name: "odm_texturing/odm_textured_model_geo.glb", data: new TextEncoder().encode("glb bytes") },
    { name: "orthophoto_tiles/16/16020/42443.png", data: new Uint8Array([137, 80, 78, 71]) },
  ]);
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
  fake.setTask(task.value.uuid, { statusCode: 40, processingTime: 100, output: ["Finished"], results: bytes });
  const run = h.runs.create({ projectId: project.id, engineId: engine.id, options: [{ name: "dsm", value: true }] });
  h.runs.update(run.id, { taskUuid: task.value.uuid, state: "queued" });
  return { run, project, bytes };
}

async function view(id: number): Promise<RunView> { return (await fetch(`${h.base}/api/runs/${id}`)).json(); }

test("completion saves results before downloads, serves outputs and tiles locally, and deletion retains the run", async () => {
  const { run, project, bytes } = await completedRun();
  const events: RunView[] = [];
  h.tracker.subscribe(run.id, event => { if (event.type === "run") events.push(event.run); });
  h.tracker.follow(run.id);
  await eventually(async () => (await view(run.id)).results?.state === "ready");
  expect(events.some(event => event.step === "results" && !event.resultsAvailable)).toBe(true);
  expect(await view(run.id)).toMatchObject({ resultsAvailable: true, results: { archiveSize: bytes.length } });
  const stored = join(h.dataFolder, "projects", String(project.id), "runs", String(run.id), "results.zip");
  expect(existsSync(stored)).toBe(true);
  expect(new Uint8Array(await Bun.file(stored).arrayBuffer())).toEqual(bytes);
  // Once fetched, reads and deletion must work with the engine offline.
  await fake.stop();
  expect(await (await fetch(`${h.base}/api/runs/${run.id}/outputs/orthophoto`)).text()).toBe("tiff bytes");
  expect(await (await fetch(`${h.base}/api/runs/${run.id}/outputs/glb`)).text()).toBe("glb bytes");
  expect(new Uint8Array(await (await fetch(`${h.base}/api/runs/${run.id}/tiles/orthophoto/16/16020/42443.png`)).arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  expect(new Uint8Array(await (await fetch(`${h.base}/api/runs/${run.id}/results`)).arrayBuffer())).toEqual(bytes);
  const range = await fetch(`${h.base}/api/runs/${run.id}/outputs/glb`, { headers: { Range: "bytes=0-2" } });
  expect(range.status).toBe(206); expect(await range.text()).toBe("glb");
  const facts = await (await fetch(`${h.base}/api/projects/${project.id}`)).json() as ProjectView;
  expect(facts.resultsBytes).toBe(bytes.length);
  expect(facts.resultArchives).toEqual([{ runId: run.id, size: bytes.length }]);
  expect((await fetch(`${h.base}/api/runs/${run.id}/results`, { method: "DELETE" })).status).toBe(200);
  expect(existsSync(stored)).toBe(false);
  expect(await view(run.id)).toMatchObject({ state: "completed", resultsAvailable: false, results: { state: "deleted" } });
  expect(h.runs.get(run.id)?.options).toEqual([{ name: "dsm", value: true }]);
  expect(h.tracker.log(run.id, 0).lines).toEqual(["Finished"]);
  expect(fake.requests.some(request => request.path === "/task/remove")).toBe(false);
  expect((await fetch(`${h.base}/api/runs/${run.id}/outputs/glb`)).status).toBe(409);
});

test("a missing local archive is reported unavailable and can be fetched again", async () => {
  const { run, project } = await completedRun();
  h.tracker.follow(run.id);
  await eventually(async () => (await view(run.id)).resultsAvailable);
  const stored = join(h.dataFolder, "projects", String(project.id), "runs", String(run.id), "results.zip");
  await import("node:fs/promises").then(fs => fs.unlink(stored));
  expect((await view(run.id)).resultsAvailable).toBe(false);
  expect((await fetch(`${h.base}/api/runs/${run.id}/results`, { method: "POST" })).status).toBe(202);
  await eventually(async () => (await view(run.id)).resultsAvailable);
});

test("corrupt archives stay unavailable and retry does not rerun or remove the task", async () => {
  const { run, bytes } = await completedRun();
  const uuid = h.runs.get(run.id)!.taskUuid!;
  fake.setTask(uuid, { results: new Uint8Array([80, 75, 3, 4]) });
  h.tracker.follow(run.id);
  await eventually(async () => (await view(run.id)).results?.state === "failed");
  expect((await fetch(`${h.base}/api/runs/${run.id}/results`)).status).toBe(409);
  fake.setTask(uuid, { results: bytes });
  expect((await fetch(`${h.base}/api/runs/${run.id}/results`, { method: "POST" })).status).toBe(202);
  await eventually(async () => (await view(run.id)).resultsAvailable);
  expect(fake.tasks.size).toBe(1);
  expect(fake.requests.filter(request => request.path === "/task/new/init")).toHaveLength(1);
  expect(fake.requests.some(request => request.path === "/task/remove")).toBe(false);
});

test("reopening resumes a pending archive and never refetches ready or deleted results", async () => {
  const folder = mkdtempSync(join(tmpdir(), "results-reopen-")); folders.push(folder);
  const { run, bytes } = await completedRun(folder);
  h.runs.update(run.id, { state: "completed" });
  await h.stop();
  h = openHarness({ dataFolder: folder, runPollMs: 20 });
  await eventually(async () => (await view(run.id)).resultsAvailable);
  const requests = fake.requests.filter(request => request.path.endsWith("/download/all.zip")).length;
  expect((await view(run.id)).results?.archiveSize).toBe(bytes.length);
  await h.stop();
  h = openHarness({ dataFolder: folder, runPollMs: 20 });
  expect((await view(run.id)).resultsAvailable).toBe(true);
  expect(fake.requests.filter(request => request.path.endsWith("/download/all.zip"))).toHaveLength(requests);
  expect((await fetch(`${h.base}/api/runs/${run.id}/results`, { method: "DELETE" })).status).toBe(200);
  await h.stop();
  h = openHarness({ dataFolder: folder, runPollMs: 20 });
  expect((await view(run.id)).results?.state).toBe("deleted");
  expect(fake.requests.filter(request => request.path.endsWith("/download/all.zip"))).toHaveLength(requests);
});

test("fetching holds the project deletion gate and shutdown aborts the archive request", async () => {
  let aborted = false;
  const { run, project } = await completedRun(undefined, endpoint => new class extends TaskClient {
    override async downloadResults(_uuid: string, options: { signal?: AbortSignal } = {}): ReturnType<TaskClient["downloadResults"]> {
      await new Promise((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("stopped")); }, { once: true });
      });
      throw new Error("Unreachable");
    }
  }(endpoint));
  h.tracker.follow(run.id);
  await eventually(async () => (await view(run.id)).step === "results");
  expect((await fetch(`${h.base}/api/projects/${project.id}`, { method: "DELETE" })).status).toBe(409);
  expect((await fetch(`${h.base}/api/runs/${run.id}/results`, { method: "DELETE" })).status).toBe(409);
  await h.stop();
  expect(aborted).toBe(true);
});

test("retry replaces a damaged saved archive with a fresh download", async () => {
  const { run, project, bytes } = await completedRun();
  h.tracker.follow(run.id);
  await eventually(async () => (await view(run.id)).resultsAvailable);
  const stored = join(h.dataFolder, "projects", String(project.id), "runs", String(run.id), "results.zip");
  await Bun.write(stored, bytes.slice(0, 20));
  expect((await view(run.id)).results?.state).toBe("failed");
  const before = fake.requests.filter(request => request.path.endsWith("/download/all.zip")).length;
  expect((await fetch(`${h.base}/api/runs/${run.id}/results`, { method: "POST" })).status).toBe(202);
  await eventually(async () => (await view(run.id)).resultsAvailable);
  expect(fake.requests.filter(request => request.path.endsWith("/download/all.zip"))).toHaveLength(before + 1);
  expect(new Uint8Array(await Bun.file(stored).arrayBuffer())).toEqual(bytes);
  expect(await (await fetch(`${h.base}/api/runs/${run.id}/outputs/glb`)).text()).toBe("glb bytes");
});
