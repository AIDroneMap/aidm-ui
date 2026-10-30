import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import type { RunReviewView } from "../../shared/run-review.ts";
import type { RunView } from "../../shared/api-types.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

let h: Harness;
let api: FakeTaskApi;
let source: ReturnType<typeof Bun.serve>;
let id: number;
let engine: number;
let methods: string[];
let delay: Promise<void> | null;
function request(method: string, path: string, body?: unknown) {
  return fetch(h.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}
function url(name = "flight.zip") { return `http://127.0.0.1:${source.port}/${name}`; }
function select(address = url()) { return request("PUT", `/api/projects/${id}/link`, { url: address }); }
async function review(): Promise<RunReviewView> { return (await request("GET", `/api/projects/${id}/run-review?engineId=${engine}&preset=quick-map`)).json(); }
async function start(view: RunReviewView) { return request("POST", `/api/projects/${id}/runs`, { engineId: engine, preset: "quick-map", name: "Linked field", revision: view.revision }); }
beforeEach(async () => {
  api = new FakeTaskApi(); await api.start(); h = openHarness({ runPollMs: 20 });
  id = h.ctx.projects.create("Linked field", "Keep notes").id;
  engine = h.engineStore.addRemote({ name: "Field engine", address: api.address, token: api.token }).id;
  methods = []; delay = null;
  source = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    methods.push(req.method); await delay;
    return new Response(null, { headers: { "content-type": "application/zip", "content-length": "900" } });
  } });
});
afterEach(async () => { await h.stop(); await api.stop(); await source.stop(true); });

test("invalid addresses fail before task creation and a read never repeats HEAD", async () => {
  expect((await select("file:///tmp/photos.zip")).status).toBe(400);
  expect(await (await select("https://user:secret@example.test/a.zip")).json()).toEqual({ error: { code: "link.invalid_url", data: {} } });
  expect(api.tasks.size).toBe(0); expect(methods).toEqual([]);
  const original = url() + "?signature=a%2Fb+z";
  expect(await (await select(original)).json()).toEqual({ url: original, size: 900, facts: null, factsRunId: null });
  expect(await (await request("GET", `/api/projects/${id}/link`)).json()).toEqual({ url: original, size: null, facts: null, factsRunId: null });
  expect(methods).toEqual(["HEAD"]);
  expect((await (await request("GET", `/api/projects/${id}`)).json()).photoCount).toBeNull();
  expect(existsSync(join(h.dataFolder, "projects", String(id)))).toBe(false);
});

test("source selection excludes uploads, folders, sample changes and stale reviews", async () => {
  expect((await select()).status).toBe(200);
  const oldReview = await review();
  expect((await select(url("other.zip"))).status).toBe(200);
  expect((await (await start(oldReview)).json()).error.code).toBe("project_run.review_changed");
  const upload = await request("POST", `/api/projects/${id}/uploads`, { name: "one.jpg", size: 3, sha256: "a".repeat(64) });
  expect(upload.status).toBe(409);
  expect((await request("PUT", `/api/projects/${id}/import`, { path: "/does-not-need-to-exist" })).status).toBe(409);
  const sample = h.ctx.projects.sampleId()!;
  expect((await request("PUT", `/api/projects/${sample}/link`, { url: url() })).status).toBe(409);
  expect((await request("DELETE", `/api/projects/${id}/link`)).status).toBe(200);
  expect((await request("POST", `/api/projects/${id}/uploads`, { name: "one.jpg", size: 3, sha256: "a".repeat(64) })).status).toBe(201);
  expect((await (await select()).json()).error.code).toBe("link.source_present");
  expect(api.tasks.size).toBe(0);
});

test("a pending HEAD prevents another source, Start and project deletion", async () => {
  let release!: () => void;
  delay = new Promise(resolve => { release = resolve; });
  const checking = select();
  try {
    await eventually(async () => methods.length === 1);
    expect((await (await select()).json()).error.code).toBe("link.busy");
    expect((await request("POST", `/api/projects/${id}/uploads`, { name: "one.jpg", size: 3, sha256: "a".repeat(64) })).status).toBe(409);
    expect((await request("PUT", `/api/projects/${id}/import`, { path: "/unused" })).status).toBe(409);
    expect((await request("GET", `/api/projects/${id}/run-review?engineId=${engine}&preset=quick-map`)).status).toBe(409);
    expect((await request("DELETE", `/api/projects/${id}`)).status).toBe(409);
  } finally { release(); await checking; }
});

test("archive facts belong to the completed run's address and disappear with local results", async () => {
  expect((await select()).status).toBe(200);
  const run = await (await start(await review())).json() as RunView;
  await eventually(async () => h.runs.get(run.id)?.taskUuid !== null);
  const uuid = h.runs.get(run.id)!.taskUuid!;
  const path = join(h.dataFolder, "fixture.zip");
  writeStoredZip(path, [{ name: "images.json", data: new TextEncoder().encode(JSON.stringify([
    { filename: "one.jpg", camera_make: "DJI", camera_model: "FC300S", width: 4000, height: 2250, latitude: 0, longitude: 0, path_file: "/private/photos/one.jpg" },
    { filename: "two.jpg", camera_make: "DJI", camera_model: "FC300S", width: 4000, height: 2250 },
  ])) }]);
  api.setTask(uuid, { statusCode: 40, processingTime: 100, results: new Uint8Array(await Bun.file(path).arrayBuffer()), output: ["Finished"] });
  await eventually(async () => h.tracker.view(run.id)?.resultsAvailable === true);
  const facts = await (await request("GET", `/api/projects/${id}/link`)).json();
  expect(facts).toMatchObject({ factsRunId: run.id, facts: { photoCount: 2, withoutGps: 1, cameras: [{ make: "DJI", model: "FC300S", photoCount: 2 }], dimensions: [{ width: 4000, height: 2250, photoCount: 2 }] } });
  expect(JSON.stringify(facts)).not.toContain("/private");
  expect((await select(url("replacement.zip"))).status).toBe(200);
  expect((await (await request("GET", `/api/projects/${id}/link`)).json()).facts).toBeNull();
  expect((await select()).status).toBe(200);
  expect((await (await request("GET", `/api/projects/${id}/link`)).json()).factsRunId).toBe(run.id);
  expect((await request("DELETE", `/api/runs/${run.id}/results`)).status).toBe(200);
  expect((await (await request("GET", `/api/projects/${id}/link`)).json()).facts).toBeNull();
  expect(api.requests.some(req => req.path === "/task/remove")).toBe(false);
});
