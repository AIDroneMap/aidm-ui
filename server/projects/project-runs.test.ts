import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { openHarness, eventually, type Harness } from "../testing/harness.ts";
import type { RunReviewView } from "../../shared/run-review.ts";
import type { RunView } from "../../shared/api-types.ts";

let h: Harness;
let api: FakeTaskApi;
let project: number;
let engine: number;
function request(method: string, path: string, body?: unknown) {
  return fetch(h.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function upload(name: string, bytes = Buffer.from("a synthetic photo")) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = `/api/projects/${project}/uploads`;
  const session = await (await request("POST", path, { name, size: bytes.length, sha256 })).json() as { id: string };
  expect((await fetch(`${h.base}${path}/${session.id}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": sha256 }, body: bytes })).status).toBe(204);
  expect((await request("POST", `${path}/${session.id}/complete`)).status).toBe(200);
}
async function review(preset = "quick-map") {
  return request("GET", `/api/projects/${project}/run-review?engineId=${engine}&preset=${preset}`);
}
async function start(view: RunReviewView) {
  return request("POST", `/api/projects/${project}/runs`, { engineId: engine, preset: view.preset, name: "Field run", revision: view.revision });
}
beforeEach(async () => {
  api = new FakeTaskApi(); await api.start(); h = openHarness();
  project = (await (await request("POST", "/api/projects", { name: "Field", notes: "" })).json() as { id: number }).id;
  engine = h.engineStore.addRemote({ name: "Chosen engine", address: api.address, token: api.token }).id;
});
afterEach(async () => { await h.stop(); await api.stop(); });

test("project photos reach the selected engine with reviewed settings and persisted run identity", async () => {
  await upload("photo.jpg");
  const response = await review(); expect(response.status).toBe(200);
  const view = await response.json() as RunReviewView;
  expect(view).toMatchObject({ project: { id: project, name: "Field" }, preset: "quick-map", wayIn: "upload", photos: { included: 1, excluded: 0, total: 1 }, blocked: null });
  expect(view.engine).toMatchObject({ id: engine, gpu: null, imageLimit: null, imageLimitReported: true, info: { cpuCores: 24 } });
  expect(view.options).toContainEqual(expect.objectContaining({ name: "fast-orthophoto", value: true, defaultValue: false }));
  expect(view.outputs).toContain("orthophoto"); expect(view.outputs).not.toContain("3d-model");
  const started = await start(view); expect(started.status).toBe(202);
  const run = await started.json() as RunView;
  await eventually(async () => api.tasks.size === 1 && [...api.tasks.values()][0]!.committed);
  const task = [...api.tasks.values()][0]!;
  expect(task.images).toHaveLength(1);
  expect(task.options).toContainEqual({ name: "tiles", value: true });
  expect(task.options).toContainEqual({ name: "fast-orthophoto", value: true });
  expect(task.options).not.toContainEqual(expect.objectContaining({ name: "no-gpu" }));
  expect(h.runs.get(run.id)).toMatchObject({ projectId: project, engineId: engine, name: "Field run", preset: "quick-map", wayIn: "upload", sample: false });
});

test("review blocks above a reported image limit, permits equality, and start rechecks it", async () => {
  await upload("one.jpg"); await upload("two.jpg", Buffer.from("another synthetic photo"));
  api.info.maxImages = 1;
  const blocked = await (await review()).json() as RunReviewView;
  expect(blocked.blocked).toEqual({ code: "project_run.image_limit", data: { count: 2, limit: 1 } });
  expect((await start(blocked)).status).toBe(409); expect(api.tasks.size).toBe(0);
  api.info.maxImages = 2;
  const equal = await (await review()).json() as RunReviewView;
  expect(equal.blocked).toBeNull(); expect(equal.engine.imageLimit).toBe(2);
  api.info.maxImages = 1;
  const refused = await start(equal);
  expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("project_run.image_limit");
  api.info.maxImages = 2;
  expect((await start(equal)).status).toBe(202);
});

test("changed inputs, defaults and unsupported presets are refused before creating tasks", async () => {
  await upload("one.jpg");
  const initial = await (await review()).json() as RunReviewView;
  await upload("two.jpg", Buffer.from("a different photo"));
  expect((await (await start(initial)).json()).error.code).toBe("project_run.review_changed");
  const current = await (await review()).json() as RunReviewView;
  api.options.find(option => option.name === "dsm")!.value = "true";
  expect((await (await start(current)).json()).error.code).toBe("project_run.review_changed");
  api.options = api.options.filter(option => option.name !== "fast-orthophoto");
  const unsupported = await (await review()).json() as RunReviewView;
  expect(unsupported.blocked?.code).toBe("project_run.preset_unavailable");
  expect((await start(unsupported)).status).toBe(409);
  expect(api.tasks.size).toBe(0);
});

test("malformed requests, sample projects, no photos and disabled engines cannot start", async () => {
  expect((await (await review()).json()).blocked.code).toBe("project_run.no_photos");
  expect((await request("GET", `/api/projects/${project}/run-review?engineId=${engine}&preset=other`)).status).toBe(400);
  expect((await request("POST", `/api/projects/${project}/runs`, { engineId: engine, preset: "quick-map", name: "", revision: "a".repeat(64) })).status).toBe(400);
  const sample = h.ctx.projects.sampleId()!;
  expect((await request("GET", `/api/projects/${sample}/run-review?engineId=${engine}&preset=quick-map`)).status).toBe(409);
  await upload("photo.jpg");
  const view = await (await review()).json() as RunReviewView;
  expect((await request("POST", `/api/projects/${project}/runs`, { engineId: engine, preset: "quick-map", name: "Run", revision: view.revision, options: [{ name: "tiles", value: false }] })).status).toBe(400);
  h.engineStore.update(engine, { enabled: false });
  expect((await start(view)).status).toBe(409); expect(api.tasks.size).toBe(0);
});

test("one preparation holds deletion off and cancellation discards the uncommitted task", async () => {
  await upload("photo.jpg"); api.uploadDelayMs = 200;
  const view = await (await review()).json() as RunReviewView;
  const started = await start(view); const run = await started.json() as RunView;
  await eventually(async () => api.requests.some(request => request.path.includes("/upload")));
  const duplicate = await start(view);
  expect(duplicate.status).toBe(409); expect((await duplicate.json()).error.code).toBe("project_run.already_running");
  expect((await request("DELETE", `/api/projects/${project}`)).status).toBe(409);
  const cancelled = await request("POST", `/api/runs/${run.id}/cancel`);
  expect(cancelled.status).toBe(200); expect((await cancelled.json()).state).toBe("cancelled");
  expect(api.tasks.size).toBe(0);
  expect(api.requests.some(request => request.path.endsWith("/commit"))).toBe(false);
  expect((await request("DELETE", `/api/projects/${project}`)).status).toBe(204);
});

test("cancelling during task creation waits for its identity and removes it without committing", async () => {
  await h.stop();
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let received = false;
  const { TaskClient } = await import("../task-api/task-client.ts");
  h = openHarness({ runClientFor: endpoint => new TaskClient(endpoint, { fetch: (async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).includes("/task/new/init")) {
      received = true;
      await Promise.race([delayed, new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("Connection cancelled")), { once: true }))]);
    }
    return response;
  }) as typeof fetch }) });
  project = h.ctx.projects.create("Field", "").id;
  engine = h.engineStore.addRemote({ name: "Chosen engine", address: api.address, token: api.token }).id;
  await upload("photo.jpg");
  const run = await (await start(await (await review()).json() as RunReviewView)).json() as RunView;
  await eventually(async () => received);
  const cancelling = h.ctx.projectRuns.cancel(run.id);
  release();
  const response = await cancelling;
  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error("Cancellation failed");
  expect(response.value.state).toBe("cancelled");
  expect(api.tasks.size).toBe(0);
  expect(api.requests.some(request => request.path.endsWith("/commit"))).toBe(false);
});

test("review waits for bounded metadata preparation before showing the complete flight list", async () => {
  for (let index = 0; index < 33; index++) await upload(`photo-${index}.jpg`, Buffer.from(`synthetic photo ${index}`));
  const pending = await (await review()).json() as RunReviewView;
  expect(pending.facts!.pendingMetadata).toBeGreaterThan(0);
  expect(pending.blocked?.code).toBe("project_run.metadata_pending");
  const complete = await (await review()).json() as RunReviewView;
  expect(complete.facts!.pendingMetadata).toBe(0);
  expect(complete.blocked).toBeNull();
});

test("an unsupported task API version is rejected before a project task is created", async () => {
  await upload("photo.jpg");
  const view = await (await review()).json() as RunReviewView;
  api.info.version = "1.0.0";
  const response = await start(view);
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("engine.unsupported_version");
  expect(api.tasks.size).toBe(0);
});

test("imported runs honor flight exclusions and leave the original folder unchanged", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { detailedTiff } = await import("../../test-support/photo-metadata.ts");
  const { folderSnapshot } = await import("../../test-support/import-folder.ts");
  const folder = await mkdtemp(join(tmpdir(), "aidm-run-source-"));
  try {
    const first = detailedTiff(true), second = Buffer.from(first);
    second.write("2024:02:29 14:34:56", 310);
    await writeFile(join(folder, "one.tif"), first); await writeFile(join(folder, "two.tif"), second);
    await writeFile(join(folder, "one_mask.png"), "mask");
    const original = await folderSnapshot(folder);
    expect((await request("PUT", `/api/projects/${project}/import`, { path: folder })).status).toBe(200);
    const initial = await (await review()).json() as RunReviewView;
    expect(initial.facts!.flightCount).toBe(2);
    expect((await request("PUT", `/api/projects/${project}/flights/${initial.facts!.flights[0]!.id}`, { excluded: true })).status).toBe(204);
    const view = await (await review()).json() as RunReviewView;
    expect(view).toMatchObject({ wayIn: "import", photos: { included: 1, excluded: 1, total: 2 } });
    expect(view.facts!.flights[0]!.excludedPhotoCount).toBe(1);
    const response = await start(view); expect(response.status).toBe(202);
    const run = await response.json() as RunView;
    await eventually(async () => [...api.tasks.values()].some(task => task.committed));
    expect([...api.tasks.values()][0]!.images).toHaveLength(1);
    expect(h.runs.get(run.id)?.wayIn).toBe("import");
    expect(await folderSnapshot(folder)).toEqual(original);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("local GPU facts and the CPU-only option come from the installed package and setting", async () => {
  await upload("photo.jpg");
  const local = h.engineStore.addLocal({ name: "Local engine", token: api.token, packageKind: "container", installedVersion: "2.5.0" });
  h.engineStore.update(local.id, { address: api.address }); engine = local.id;
  h.settings.set("local.package", { packageVersion: "2.5.0", variant: "linux-amd64-gpu", runtime: "docker", container: { kind: "container", image: "example/engine", digest: "sha256:" + "a".repeat(64), size: 1, gpu: true } });
  const gpu = await (await review()).json() as RunReviewView;
  expect(gpu.engine.gpu).toBe(true);
  h.settings.set("local.forceCpu", true);
  expect((await (await start(gpu)).json()).error.code).toBe("project_run.review_changed");
  const cpu = await (await review()).json() as RunReviewView;
  expect(cpu.engine.gpu).toBe(false);
  expect((await start(cpu)).status).toBe(202);
  await eventually(async () => [...api.tasks.values()].some(task => task.committed));
  expect([...api.tasks.values()][0]!.options).toContainEqual({ name: "no-gpu", value: true });
});

test("disabling the engine while Start checks its facts prevents task creation", async () => {
  await upload("photo.jpg");
  const view = await (await review()).json() as RunReviewView;
  api.infoDelayMs = 120;
  const previous = api.requests.filter(request => request.path === "/info").length;
  const response = start(view);
  await eventually(async () => api.requests.filter(request => request.path === "/info").length > previous);
  h.engineStore.update(engine, { enabled: false });
  expect((await response).status).toBe(409);
  expect(api.tasks.size).toBe(0);
});

test("a checked ZIP link starts directly without a photo upload or commit", async () => {
  const methods: string[] = [];
  const source = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => {
    methods.push(req.method);
    return new Response(null, { headers: { "content-type": "application/zip", "content-length": "123456" } });
  } });
  try {
    const url = `http://127.0.0.1:${source.port}/flight.zip?signature=a%2Bb`;
    const checked = await request("PUT", `/api/projects/${project}/link`, { url });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ url, size: 123456, facts: null });
    const view = await (await review()).json() as RunReviewView;
    expect(view).toMatchObject({ wayIn: "link", facts: null, photos: { included: null, excluded: null, total: null, bytes: null }, blocked: null });
    api.info.maxImages = 1;
    const limited = await (await review()).json() as RunReviewView;
    expect(limited.blocked).toBeNull();
    const observed: Array<{ state: string; uuid: string | null }> = [];
    const unsubscribe = h.tracker.subscribe(1, event => {
      if (event.type !== "run") return;
      const saved = h.runs.get(event.run.id)!;
      observed.push({ state: saved.state, uuid: saved.taskUuid });
    });
    const started = await start(limited);
    expect(started.status).toBe(202);
    const run = await started.json() as RunView;
    await eventually(async () => api.tasks.size === 1);
    expect([...api.tasks.values()][0]).toMatchObject({ zipurl: url, committed: true, images: [] });
    expect(api.requests.filter(req => req.method === "POST").map(req => req.path)).toEqual(["/task/new"]);
    expect(h.runs.get(run.id)?.wayIn).toBe("link");
    expect(observed.some(saved => saved.uuid !== null)).toBe(true);
    expect(observed.filter(saved => saved.uuid !== null).every(saved => saved.state !== "created" && saved.state !== "uploading")).toBe(true);
    unsubscribe();
    expect(methods).toEqual(["HEAD"]);
  } finally { await source.stop(true); }
});

test("cancelling linked creation waits for its identity and cancels the submitted task", async () => {
  await h.stop();
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let received = false;
  const { TaskClient } = await import("../task-api/task-client.ts");
  h = openHarness({ runClientFor: endpoint => new TaskClient(endpoint, { fetch: (async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(String(input)).pathname === "/task/new") { received = true; await delayed; }
    return response;
  }) as typeof fetch }) });
  project = h.ctx.projects.create("Linked", "").id;
  engine = h.engineStore.addRemote({ name: "Chosen engine", address: api.address, token: api.token }).id;
  const source = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { headers: { "content-type": "application/zip", "content-length": "123" } }) });
  try {
    const path = `/api/projects/${project}/link`;
    expect((await request("PUT", path, { url: `http://127.0.0.1:${source.port}/photos.zip` })).status).toBe(200);
    const run = await (await start(await (await review()).json() as RunReviewView)).json() as RunView;
    expect(run.state).toBe("created");
    await eventually(async () => received);
    expect((await request("DELETE", path)).status).toBe(409);
    expect((await request("DELETE", `/api/projects/${project}`)).status).toBe(409);
    const cancelling = h.ctx.projectRuns.cancel(run.id);
    release();
    const result = await cancelling;
    expect(result?.ok).toBe(true);
    if (!result?.ok) throw new Error("Cancellation failed");
    expect(result.value.state).toBe("cancelled");
    expect(h.runs.get(run.id)?.taskUuid).not.toBeNull();
    expect(api.requests.filter(req => req.method === "POST").map(req => req.path)).toEqual(["/task/new", "/task/cancel"]);
    expect(api.tasks.size).toBe(1);
    expect((await request("DELETE", `/api/projects/${project}`)).status).toBe(204);
    expect(api.tasks.size).toBe(0);
  } finally { release(); await source.stop(true); }
});
