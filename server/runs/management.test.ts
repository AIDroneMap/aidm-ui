import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { folderSnapshot } from "../../test-support/import-folder.ts";
import { TaskClient } from "../task-api/task-client.ts";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";
import type { RunView } from "../../shared/api-types.ts";
import type { RunReviewView } from "../../shared/run-review.ts";

let h: Harness, api: FakeTaskApi, project: number, engine: number;
const send = (method: string, path: string, body?: unknown) => fetch(h.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
async function upload(name: string, text: string) {
  const bytes = Buffer.from(text), sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = `/api/projects/${project}/uploads`;
  const session = await (await send("POST", path, { name, sha256, size: bytes.length })).json() as { id: string };
  expect((await fetch(`${h.base}${path}/${session.id}/chunks/0`, { method: "PUT", body: bytes, headers: { "x-chunk-sha256": sha256 } })).status).toBe(204);
  expect((await send("POST", `${path}/${session.id}/complete`)).status).toBe(200);
}
async function initial() {
  await upload("first.jpg", "first synthetic photo");
  const review = await (await send("GET", `/api/projects/${project}/run-review?engineId=${engine}&preset=quick-map`)).json() as RunReviewView;
  const response = await send("POST", `/api/projects/${project}/runs`, { engineId: engine, preset: "quick-map", name: "Original", revision: review.revision });
  expect(response.status).toBe(202);
  const run = await response.json() as RunView;
  await eventually(async () => h.runs.get(run.id)?.state === "queued");
  return h.runs.get(run.id)!;
}
beforeEach(async () => {
  api = new FakeTaskApi(); await api.start(); h = openHarness({ runPollMs: 10 });
  project = h.ctx.projects.create("Field", "").id;
  engine = h.engineStore.addRemote({ name: "First engine", address: api.address, token: api.token }).id;
});
afterEach(async () => { await h.stop(); await api.stop(); });

test("retry restarts the same task without uploads and retains the original options and log", async () => {
  const original = await initial();
  api.setTask(original.taskUuid!, { statusCode: 30, errorMessage: "Processing failed", output: ["Original log"] });
  await eventually(async () => h.runs.get(original.id)?.state === "failed");
  const response = await send("POST", `/api/runs/${original.id}/retry`);
  expect(response.status).toBe(202);
  const retry = await response.json() as RunView;
  expect(retry.id).not.toBe(original.id);
  await eventually(async () => h.runs.get(retry.id)?.state === "queued");
  expect(h.runs.get(retry.id)).toMatchObject({ options: original.options, taskUuid: original.taskUuid });
  expect(api.uploads).toHaveLength(1);
  expect(api.tasks.size).toBe(1);
  expect(h.tracker.log(original.id, 0).lines).toEqual(["Original log"]);
  expect(h.tracker.log(retry.id, 0).lines).toEqual([]);
  expect(h.runs.get(original.id)?.state).toBe("failed");
});

test("a missing task is recreated from the original uploads after the project changes", async () => {
  const original = await initial();
  api.setTask(original.taskUuid!, { statusCode: 30 });
  await eventually(async () => h.runs.get(original.id)?.state === "failed");
  const originalImages = [...api.tasks.get(original.taskUuid!)!.images];
  await upload("later.jpg", "a later flight");
  api.tasks.delete(original.taskUuid!);
  const response = await send("POST", `/api/runs/${original.id}/retry`);
  expect(response.status).toBe(202);
  const retry = await response.json() as RunView;
  await eventually(async () => h.runs.get(retry.id)?.state === "queued");
  const next = h.runs.get(retry.id)!;
  expect(next.taskUuid).not.toBe(original.taskUuid);
  expect(api.tasks.get(next.taskUuid!)?.images).toEqual(originalImages);
  expect(api.tasks.get(next.taskUuid!)?.options).toEqual(original.options);
  expect(api.uploads).toHaveLength(2);
});

test("run again reviews original photos, restarts with changed settings and creates a task on another engine", async () => {
  const original = await initial();
  api.setTask(original.taskUuid!, { statusCode: 30 });
  await eventually(async () => h.runs.get(original.id)?.state === "failed");
  await upload("later.jpg", "later photos");
  const again = async (engineId: number, value: number) => {
    const body = { engineId, preset: "custom", sourceRunId: original.id, options: [{ name: "orthophoto-resolution", value }] };
    const response = await send("POST", `/api/projects/${project}/run-review`, body);
    expect(response.status).toBe(200);
    const review = await response.json() as RunReviewView;
    expect(review.photos.included).toBe(1);
    const started = await send("POST", `/api/projects/${project}/runs`, { ...body, name: "Another run", revision: review.revision });
    expect(started.status).toBe(202);
    const run = await started.json() as RunView;
    await eventually(async () => h.runs.get(run.id)?.state === "queued");
    return h.runs.get(run.id)!;
  };
  const changed = await again(engine, 8);
  expect(changed.taskUuid).toBe(original.taskUuid);
  expect(api.tasks.get(changed.taskUuid!)?.options).toContainEqual({ name: "orthophoto-resolution", value: 8 });
  expect(api.uploads).toHaveLength(1);
  const other = new FakeTaskApi(); await other.start();
  try {
    const id = h.engineStore.addRemote({ name: "Other engine", address: other.address, token: other.token }).id;
    const remote = await again(id, 9);
    expect(remote.engineId).toBe(id);
    expect(other.tasks.size).toBe(1);
    expect(other.uploads).toHaveLength(1);
    expect(other.requests.some(request => request.path === "/task/restart")).toBe(false);
    expect(other.tasks.get(remote.taskUuid!)?.options).toContainEqual({ name: "orthophoto-resolution", value: 9 });
  } finally { await other.stop(); }
});

test("project run history is newest first and delete removes its engine task and record", async () => {
  const original = await initial();
  api.setTask(original.taskUuid!, { statusCode: 30 });
  await eventually(async () => h.runs.get(original.id)?.state === "failed");
  const retry = await (await send("POST", `/api/runs/${original.id}/retry`)).json() as RunView;
  await eventually(async () => h.runs.get(retry.id)?.state === "queued");
  const response = await send("GET", `/api/projects/${project}/runs`);
  expect(response.status).toBe(200);
  expect((await response.json()).runs.map((run: RunView) => run.id)).toEqual([retry.id, original.id]);
  expect((await send("DELETE", `/api/runs/${original.id}`)).status).toBe(409);
  expect((await send("DELETE", `/api/runs/${retry.id}`)).status).toBe(204);
  expect(api.tasks.size).toBe(0);
  expect(h.runs.get(retry.id)).toBeNull();
  expect(h.runs.get(original.id)?.state).toBe("failed");
  expect((await send("DELETE", `/api/runs/${original.id}`)).status).toBe(204);
});

test("waiting shows the engine total rather than counting this interface's runs", async () => {
  api.info.taskQueueCount = 7;
  const original = await initial();
  await eventually(async () => h.tracker.view(original.id)?.queueCount === 8);
  expect(api.requests.some(request => request.path === "/info")).toBe(true);
});

test("an active task lost by the engine is recovered without operator action", async () => {
  const original = await initial();
  api.tasks.delete(original.taskUuid!);
  await eventually(async () => h.runs.get(original.id)?.taskUuid !== original.taskUuid && h.runs.get(original.id)?.state === "queued");
  expect(api.tasks.size).toBe(1);
  expect(api.uploads).toHaveLength(2);
  expect(h.runs.get(original.id)?.options).toEqual(original.options);
});

test("rerunning a completed task preserves its archive and deletion removes only the chosen run", async () => {
  const original = await initial();
  const fixture = join(h.dataFolder, "archive.zip");
  writeStoredZip(fixture, [{ name: "odm_report/report.pdf", data: Buffer.from("original report") }]);
  const archive = await readFile(fixture);
  api.setTask(original.taskUuid!, { statusCode: 40, results: archive, output: ["Finished original"] });
  await eventually(async () => h.tracker.view(original.id)?.resultsAvailable === true);
  const body = { engineId: engine, preset: "custom", sourceRunId: original.id, options: [{ name: "orthophoto-resolution", value: 8 }] };
  const review = await (await send("POST", `/api/projects/${project}/run-review`, body)).json() as RunReviewView;
  const repeated = await send("POST", `/api/projects/${project}/runs`, { ...body, name: "Rerun", revision: review.revision });
  const run = await repeated.json() as RunView;
  await eventually(async () => h.runs.get(run.id)?.state === "queued");
  expect(Buffer.from(await (await send("GET", `/api/runs/${original.id}/results`)).arrayBuffer())).toEqual(archive);
  expect(h.tracker.log(original.id, 0).lines).toEqual(["Finished original"]);
  api.setTask(original.taskUuid!, { statusCode: 30 });
  await eventually(async () => h.runs.get(run.id)?.state === "failed");
  expect((await send("DELETE", `/api/runs/${original.id}`)).status).toBe(204);
  expect(await Bun.file(h.tracker.results.path(original)).exists()).toBe(false);
  expect(api.tasks.has(original.taskUuid!)).toBe(true);
  expect(h.runs.get(run.id)?.state).toBe("failed");
});

test("linked recovery uses the original private URL after project selection changes and restart", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-replay-"));
  const source = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { headers: { "content-type": "application/zip", "content-length": "10" } }) });
  try {
    await h.stop(); h = openHarness({ dataFolder: folder, runPollMs: 10 });
    project = h.ctx.projects.create("Linked", "").id; engine = h.engineStore.addRemote({ name: "Engine", address: api.address, token: api.token }).id;
    const originalUrl = `http://127.0.0.1:${source.port}/first.zip?signed=original`;
    expect((await send("PUT", `/api/projects/${project}/link`, { url: originalUrl })).status).toBe(200);
    const review = await (await send("GET", `/api/projects/${project}/run-review?engineId=${engine}&preset=quick-map`)).json() as RunReviewView;
    const run = await (await send("POST", `/api/projects/${project}/runs`, { engineId: engine, preset: "quick-map", name: "Linked", revision: review.revision })).json() as RunView;
    await eventually(async () => h.runs.get(run.id)?.state === "queued");
    const uuid = h.runs.get(run.id)!.taskUuid!;
    api.setTask(uuid, { statusCode: 30 }); await eventually(async () => h.runs.get(run.id)?.state === "failed");
    expect((await send("DELETE", `/api/projects/${project}/link`)).status).toBe(200);
    expect((await send("PUT", `/api/projects/${project}/link`, { url: `http://127.0.0.1:${source.port}/other.zip` })).status).toBe(200);
    await h.stop(); h = openHarness({ dataFolder: folder, runPollMs: 10 }); api.tasks.delete(uuid);
    const retry = await (await send("POST", `/api/runs/${run.id}/retry`)).json() as RunView;
    await eventually(async () => h.runs.get(retry.id)?.state === "queued");
    expect(api.tasks.get(h.runs.get(retry.id)!.taskUuid!)?.zipurl).toBe(originalUrl);
    expect(JSON.stringify(await (await send("GET", `/api/runs/${retry.id}/settings`)).json())).not.toContain(originalUrl);
    expect(api.uploads).toHaveLength(0);
  } finally { await h.stop(); await source.stop(true); await rm(folder, { recursive: true, force: true }); }
});

test("import recovery keeps the original folder selection and never changes its files", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-original-import-"));
  const other = await mkdtemp(join(tmpdir(), "aidm-other-import-"));
  try {
    await writeFile(join(folder, "one.jpg"), "original import"); await writeFile(join(other, "new.jpg"), "different import");
    const before = await folderSnapshot(folder);
    expect((await send("PUT", `/api/projects/${project}/import`, { path: folder })).status).toBe(200);
    const review = await (await send("GET", `/api/projects/${project}/run-review?engineId=${engine}&preset=quick-map`)).json() as RunReviewView;
    const run = await (await send("POST", `/api/projects/${project}/runs`, { engineId: engine, preset: "quick-map", name: "Imported", revision: review.revision })).json() as RunView;
    await eventually(async () => h.runs.get(run.id)?.state === "queued");
    const uuid = h.runs.get(run.id)!.taskUuid!, images = api.tasks.get(uuid)!.images.slice();
    api.setTask(uuid, { statusCode: 30 }); await eventually(async () => h.runs.get(run.id)?.state === "failed");
    expect((await send("PUT", `/api/projects/${project}/import`, { path: other })).status).toBe(200);
    api.tasks.delete(uuid);
    const retry = await (await send("POST", `/api/runs/${run.id}/retry`)).json() as RunView;
    await eventually(async () => h.runs.get(retry.id)?.state === "queued");
    expect(api.tasks.get(h.runs.get(retry.id)!.taskUuid!)?.images).toEqual(images);
    expect(await folderSnapshot(folder)).toEqual(before);
    api.setTask(h.runs.get(retry.id)!.taskUuid!, { statusCode: 30 }); await eventually(async () => h.runs.get(retry.id)?.state === "failed");
    api.tasks.clear(); await writeFile(join(folder, "one.jpg"), "changed original");
    const failed = await (await send("POST", `/api/runs/${run.id}/retry`)).json() as RunView;
    await eventually(async () => h.runs.get(failed.id)?.state === "failed");
    expect(h.runs.get(failed.id)?.problem?.code).toBe("project_run.photos_changed");
    expect(api.tasks.size).toBe(0);
  } finally { await rm(folder, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test("authentication failure cannot create duplicate tasks, and failed deletion keeps the run", async () => {
  const run = await initial(); api.setTask(run.taskUuid!, { statusCode: 30 });
  await eventually(async () => h.runs.get(run.id)?.state === "failed");
  api.token = "different";
  const retry = await (await send("POST", `/api/runs/${run.id}/retry`)).json() as RunView;
  await eventually(async () => h.runs.get(retry.id)?.state === "failed");
  expect(api.tasks.size).toBe(1); expect(api.uploads).toHaveLength(1);
  expect((await send("DELETE", `/api/runs/${run.id}`)).status).toBe(502);
  expect(h.runs.get(run.id)?.state).toBe("failed");
});

test("a restart whose response is lost follows the existing task instead of creating a duplicate", async () => {
  await h.stop();
  h = openHarness({ runPollMs: 10, runClientFor: endpoint => new TaskClient(endpoint, { fetch: (async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(String(input)).pathname === "/task/restart") { await response.body?.cancel(); throw new Error("Lost restart response"); }
    return response;
  }) as typeof fetch }) });
  project = h.ctx.projects.create("Field", "").id; engine = h.engineStore.addRemote({ name: "Engine", address: api.address, token: api.token }).id;
  const run = await initial(); api.setTask(run.taskUuid!, { statusCode: 30 });
  await eventually(async () => h.runs.get(run.id)?.state === "failed");
  const retry = await (await send("POST", `/api/runs/${run.id}/retry`)).json() as RunView;
  await eventually(async () => h.runs.get(retry.id)?.state === "queued");
  expect(h.runs.get(retry.id)?.taskUuid).toBe(run.taskUuid);
  expect(api.tasks.size).toBe(1); expect(api.uploads).toHaveLength(1);
});

test("a restart that never reaches the engine cannot reuse the previous completed archive", async () => {
  await h.stop();
  h = openHarness({ runPollMs: 10, runClientFor: endpoint => new TaskClient(endpoint, { fetch: (async (input, init) => {
    if (new URL(String(input)).pathname === "/task/restart") throw new Error("Restart request did not reach the engine");
    return fetch(input, init);
  }) as typeof fetch }) });
  project = h.ctx.projects.create("Field", "").id; engine = h.engineStore.addRemote({ name: "Engine", address: api.address, token: api.token }).id;
  const original = await initial();
  const fixture = join(h.dataFolder, "archive.zip"); writeStoredZip(fixture, [{ name: "odm_report/report.pdf", data: Buffer.from("original") }]);
  api.setTask(original.taskUuid!, { statusCode: 40, results: await readFile(fixture), output: ["Original completed"] });
  await eventually(async () => h.tracker.view(original.id)?.resultsAvailable === true);
  const body = { engineId: engine, preset: "custom", sourceRunId: original.id, options: [{ name: "orthophoto-resolution", value: 8 }] };
  const review = await (await send("POST", `/api/projects/${project}/run-review`, body)).json() as RunReviewView;
  const repeated = await (await send("POST", `/api/projects/${project}/runs`, { ...body, name: "Unconfirmed restart", revision: review.revision })).json() as RunView;
  await eventually(async () => h.runs.get(repeated.id)?.problem?.code === "run.restart_unconfirmed");
  expect(h.tracker.view(repeated.id)?.resultsAvailable).toBe(false);
  expect(h.tracker.log(repeated.id, 0).lines).toEqual([]);
  expect(api.tasks.size).toBe(1); expect(api.uploads).toHaveLength(1);
});

test("cancelling during a restart with a lost response still cancels the engine task", async () => {
  await h.stop();
  let received = false, release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  h = openHarness({ runPollMs: 10, runClientFor: endpoint => new TaskClient(endpoint, { fetch: (async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(String(input)).pathname === "/task/restart") { received = true; await delayed; await response.body?.cancel(); throw new Error("Lost restart response"); }
    return response;
  }) as typeof fetch }) });
  project = h.ctx.projects.create("Field", "").id; engine = h.engineStore.addRemote({ name: "Engine", address: api.address, token: api.token }).id;
  try {
    const original = await initial(); api.setTask(original.taskUuid!, { statusCode: 30 });
    await eventually(async () => h.runs.get(original.id)?.state === "failed");
    const run = await (await send("POST", `/api/runs/${original.id}/retry`)).json() as RunView;
    await eventually(async () => received);
    const cancelling = h.ctx.projectRuns.cancel(run.id); release();
    const result = await cancelling;
    expect(result?.ok && result.value.state).toBe("cancelled");
    expect(api.tasks.get(original.taskUuid!)?.statusCode).toBe(50);
    expect(api.uploads).toHaveLength(1);
  } finally { release(); }
});
