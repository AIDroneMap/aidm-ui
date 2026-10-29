import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { openHarness, type Harness } from "../testing/harness.ts";
import type { ProjectView } from "../../shared/api-types.ts";
import { projectRoutes } from "./routes.ts";
import type { RequestContext } from "../http/route-table.ts";

let harness: Harness;
beforeEach(() => { harness = openHarness(); });
afterEach(async () => { await harness.stop(); });

function digest(data: string | Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }
async function project(): Promise<ProjectView> {
  return await (await fetch(`${harness.base}/api/projects`, { method: "POST", body: JSON.stringify({ name: "Survey", notes: "" }) })).json() as ProjectView;
}
function upload(projectId: number, name: string, data: string): Promise<Response> {
  return fetch(`${harness.base}/api/projects/${projectId}/uploads`, { method: "POST", body: JSON.stringify({ name, size: Buffer.byteLength(data), sha256: digest(data) }) });
}

test("starts a resumable session for a project file", async () => {
  const created = await project();
  const response = await upload(created.id, "flight/photo.jpg", "photo");
  expect(response.status).toBe(201);
  const session = await response.json() as { id: string; chunkSize: number; received: number[]; complete: boolean };
  expect(session.id).toMatch(/^[a-f0-9]{32}$/);
  expect(session.chunkSize).toBeGreaterThan(0);
  expect(session.received).toEqual([]);
  expect(session.complete).toBe(false);
  expect(await (await fetch(`${harness.base}/api/projects/${created.id}/uploads/${session.id}`)).json()).toEqual(session);
});

test("stores a verified chunk and reports it on resume", async () => {
  const created = await project();
  const session = await (await upload(created.id, "image.jpg", "photo bytes")).json() as { id: string; chunkSize: number };
  const path = `${harness.base}/api/projects/${created.id}/uploads/${session.id}`;
  const put = () => fetch(`${path}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": digest("photo bytes") }, body: "photo bytes" });
  expect((await put()).status).toBe(204);
  expect((await put()).status).toBe(204);
  expect(await (await fetch(path)).json()).toEqual({ id: session.id, chunkSize: session.chunkSize, received: [0], complete: false });
});

test("completes multi-chunk photos once and retains same-content aliases", async () => {
  const created = await project();
  const bytes = Buffer.alloc(1024 * 1024 + 7, 42);
  const response = await fetch(`${harness.base}/api/projects/${created.id}/uploads`, { method: "POST", body: JSON.stringify({ name: "flight/a.jpg", size: bytes.length, sha256: digest(bytes) }) });
  const session = await response.json() as { id: string; chunkSize: number };
  const path = `${harness.base}/api/projects/${created.id}/uploads/${session.id}`;
  expect((await fetch(`${path}/complete`, { method: "POST" })).status).toBe(409);
  for (let index = 0; index < Math.ceil(bytes.length / session.chunkSize); index++) {
    const chunk = bytes.subarray(index * session.chunkSize, (index + 1) * session.chunkSize);
    expect((await fetch(`${path}/chunks/${index}`, { method: "PUT", headers: { "x-chunk-sha256": digest(chunk) }, body: chunk })).status).toBe(204);
  }
  expect((await fetch(`${path}/complete`, { method: "POST" })).status).toBe(200);
  const alias = await (await fetch(`${harness.base}/api/projects/${created.id}/uploads`, { method: "POST", body: JSON.stringify({ name: "flight/b.jpg", size: bytes.length, sha256: digest(bytes) }) })).json() as { complete: boolean };
  expect(alias.complete).toBe(true);
  const listing = await (await fetch(`${harness.base}/api/projects/${created.id}/photos`)).json() as { files: { name: string; size: number; sha256: string; kind: string }[] };
  expect(listing.files).toEqual([
    { name: "flight/a.jpg", size: bytes.length, sha256: digest(bytes), kind: "photo" },
    { name: "flight/b.jpg", size: bytes.length, sha256: digest(bytes), kind: "photo" },
  ]);
  expect((await (await fetch(`${harness.base}/api/projects/${created.id}`)).json() as ProjectView).photoCount).toBe(1);
  const directory = join(harness.dataFolder, "projects", String(created.id), "files");
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect(await readFile(join(directory, files[0]!))).toEqual(bytes);
});

test("rejects damaged chunks and missing stored bytes and permits retry", async () => {
  const created = await project();
  const session = await (await upload(created.id, "image.jpg", "correct")).json() as { id: string };
  const path = `${harness.base}/api/projects/${created.id}/uploads/${session.id}`;
  const put = (body: string, checksum: string) => fetch(`${path}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": checksum }, body });
  expect((await put("damaged", digest("correct"))).status).toBe(400);
  expect((await (await fetch(path)).json() as { received: number[] }).received).toEqual([]);
  expect((await put("damaged", digest("damaged"))).status).toBe(204);
  expect((await fetch(`${path}/complete`, { method: "POST" })).status).toBe(400);
  expect((await put("correct", digest("correct"))).status).toBe(204);
  await rm(join(harness.dataFolder, "projects", String(created.id), "uploads", session.id, "0"));
  expect((await (await upload(created.id, "image.jpg", "correct")).json() as { received: number[] }).received).toEqual([]);
  expect((await (await fetch(path)).json() as { received: number[] }).received).toEqual([]);
  expect((await fetch(`${path}/complete`, { method: "POST" })).status).toBe(409);
  expect((await put("correct", digest("correct"))).status).toBe(204);
  expect((await fetch(`${path}/complete`, { method: "POST" })).status).toBe(200);
});

test("cancels a pending session without touching another upload", async () => {
  const created = await project();
  const first = await (await upload(created.id, "first.jpg", "first")).json() as { id: string };
  const second = await (await upload(created.id, "second.jpg", "second")).json() as { id: string };
  const root = `${harness.base}/api/projects/${created.id}/uploads`;
  for (const [session, bytes] of [[first, "first"], [second, "second"]] as const) {
    expect((await fetch(`${root}/${session.id}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": digest(bytes) }, body: bytes })).status).toBe(204);
  }
  expect((await fetch(`${root}/${first.id}`, { method: "DELETE" })).status).toBe(204);
  expect((await fetch(`${root}/${first.id}`)).status).toBe(404);
  expect((await fetch(`${root}/${second.id}`)).status).toBe(200);
  expect(await Bun.file(join(harness.dataFolder, "projects", String(created.id), "uploads", second.id, "0")).exists()).toBe(true);
  expect(await Bun.file(join(harness.dataFolder, "projects", String(created.id), "uploads", first.id, "0")).exists()).toBe(false);
});

test("rejects unsafe relative names and refuses the hidden sample project", async () => {
  const created = await project();
  for (const name of ["../escape.jpg", "/absolute.jpg", "flight/../image.jpg", "flight\\image.jpg"]) {
    expect((await upload(created.id, name, "photo")).status).toBe(400);
  }
  const sample = harness.ctx.projects.sampleId()!;
  const root = `${harness.base}/api/projects/${sample}/uploads`;
  expect((await upload(sample, "image.jpg", "photo")).status).toBe(409);
  expect((await fetch(`${root}/unknown`)).status).toBe(409);
  expect((await fetch(`${root}/unknown`, { method: "DELETE" })).status).toBe(409);
  expect((await fetch(`${root}/unknown/chunks/0`, { method: "PUT", body: "photo" })).status).toBe(409);
  expect((await fetch(`${root}/unknown/complete`, { method: "POST" })).status).toBe(409);
});

test("old sessions cannot cross projects or survive project ID reuse", async () => {
  const first = await project();
  const other = await project();
  const session = await (await upload(other.id, "image.jpg", "photo")).json() as { id: string };
  const old = `${harness.base}/api/projects/${other.id}/uploads/${session.id}`;
  expect((await fetch(`${harness.base}/api/projects/${first.id}/uploads/${session.id}`)).status).toBe(404);
  expect((await fetch(`${harness.base}/api/projects/${other.id}`, { method: "DELETE" })).status).toBe(204);
  const replacement = await project();
  expect(replacement.id).toBe(other.id);
  expect((await fetch(old)).status).toBe(404);
  expect((await fetch(`${old}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": digest("photo") }, body: "photo" })).status).toBe(404);
  expect((await fetch(`${old}/complete`, { method: "POST" })).status).toBe(404);
});

test("project deletion refuses an admitted chunk write and removes its bytes afterward", async () => {
  const created = await project();
  const session = await (await upload(created.id, "image.jpg", "photo")).json() as { id: string };
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const body = new ReadableStream<Uint8Array>({ async pull(controller) { started(); await waiting; controller.enqueue(new TextEncoder().encode("photo")); controller.close(); } });
  const request = Object.assign(new Request("http://localhost/chunk", { method: "PUT", headers: { "x-chunk-sha256": digest("photo") }, body }), { params: { id: String(created.id), uploadId: session.id, index: "0" } }) as unknown as Bun.BunRequest;
  const route = projectRoutes(harness.ctx)["/api/projects/:id/uploads/:uploadId/chunks/:index"]!.PUT!;
  const writing = Promise.resolve(route(request, { server: { timeout() {} } } as unknown as RequestContext));
  try {
    await entered;
    expect((await fetch(`${harness.base}/api/projects/${created.id}`, { method: "DELETE" })).status).toBe(409);
  } finally { release(); }
  expect((await writing).status).toBe(204);
  expect((await fetch(`${harness.base}/api/projects/${created.id}`, { method: "DELETE" })).status).toBe(204);
  expect(await Bun.file(join(harness.dataFolder, "projects", String(created.id), "uploads", session.id, "0")).exists()).toBe(false);
});

test("a claimed project deletion refuses new uploads", async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { started(); await waiting; return Response.json({ success: true }); } });
  try {
    const created = await project();
    const session = await (await upload(created.id, "image.jpg", "photo")).json() as { id: string };
    const engine = harness.engineStore.addRemote({ name: "Engine", address: `http://127.0.0.1:${server.port}`, token: "token" });
    const run = harness.runs.create({ projectId: created.id, engineId: engine.id, options: [] });
    harness.runs.update(run.id, { taskUuid: "task", state: "failed" });
    const deleting = fetch(`${harness.base}/api/projects/${created.id}`, { method: "DELETE" });
    await entered;
    expect((await upload(created.id, "new.jpg", "photo")).status).toBe(409);
    const root = `${harness.base}/api/projects/${created.id}/uploads/${session.id}`;
    expect((await fetch(`${root}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": digest("photo") }, body: "photo" })).status).toBe(409);
    expect((await fetch(`${root}/complete`, { method: "POST" })).status).toBe(409);
    release();
    expect((await deleting).status).toBe(204);
  } finally { release(); await server.stop(true); }
});

test("counts only distinct photo content and paginates all file aliases", async () => {
  const created = await project();
  const root = `${harness.base}/api/projects/${created.id}`;
  for (const [name, bytes] of [["flight/mask_mask.png", "mask"], ["flight/video.mov", "video"], ["flight/photo.jpg", "photo"], ["flight/photo.png", "photo"]] as const) {
    const session = await (await upload(created.id, name, bytes)).json() as { id: string; complete: boolean };
    if (!session.complete) {
      expect((await fetch(`${root}/uploads/${session.id}/chunks/0`, { method: "PUT", headers: { "x-chunk-sha256": digest(bytes) }, body: bytes })).status).toBe(204);
      expect((await fetch(`${root}/uploads/${session.id}/complete`, { method: "POST" })).status).toBe(200);
    }
  }
  expect((await (await fetch(root)).json() as ProjectView).photoCount).toBe(1);
  const first = await (await fetch(`${root}/photos?limit=2`)).json() as { files: { name: string; kind: string }[]; nextOffset: number | null };
  expect(first.files.map(file => file.kind)).toEqual(["mask", "photo"]);
  expect(first.nextOffset).toBe(2);
  const second = await (await fetch(`${root}/photos?limit=2&offset=2`)).json() as { files: { kind: string }[]; nextOffset: number | null };
  expect(second.files.map(file => file.kind)).toEqual(["photo", "video"]);
  expect(second.nextOffset).toBeNull();
});

test("rejects invalid indexes before reading and stops an oversized chunk", async () => {
  const created = await project();
  const session = await (await upload(created.id, "image.jpg", "ok")).json() as { id: string };
  const route = projectRoutes(harness.ctx)["/api/projects/:id/uploads/:uploadId/chunks/:index"]!.PUT!;
  const context = { server: { timeout() {} } } as unknown as RequestContext;
  let reads = 0;
  function request(index: string): Bun.BunRequest {
    const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array([1, 2, 3])); } }, { highWaterMark: 0 });
    return { params: { id: String(created.id), uploadId: session.id, index }, headers: new Headers({ "x-chunk-sha256": digest("ok") }), body } as unknown as Bun.BunRequest;
  }
  expect((await route(request("1"), context)).status).toBe(400);
  expect(reads).toBe(0);
  expect((await route(request("0"), context)).status).toBe(400);
  expect(reads).toBe(1);
  expect((await (await fetch(`${harness.base}/api/projects/${created.id}/uploads/${session.id}`)).json() as { received: number[] }).received).toEqual([]);
});
