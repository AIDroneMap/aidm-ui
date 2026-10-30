import { afterEach, expect, test } from "bun:test";
import { lanTest, openHarness, type Harness } from "../testing/harness.ts";
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { folderSnapshot } from "../../test-support/import-folder.ts";
import { detailedTiff } from "../../test-support/photo-metadata.ts";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { TaskClient } from "../task-api/task-client.ts";
import type { FolderImportView, ProjectPhotoFactsView } from "../../shared/api-types.ts";
import { projectRoutes } from "./routes.ts";
import { Database } from "bun:sqlite";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { DATABASE_FILE } from "../db/database.ts";
import { ProjectStore } from "./project-store.ts";
import { UploadStore } from "./upload-store.ts";
import { PhotoStore } from "../photos/photo-store.ts";
import { createHash } from "node:crypto";

let harness: Harness | undefined;
const folders: string[] = [];
afterEach(async () => {
  await harness?.stop(); harness = undefined;
  async function writable(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await writable(join(path, name));
  }
  for (const path of folders.splice(0)) { await writable(path); await rm(path, { recursive: true, force: true }); }
});
async function scratch(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "aidm-import-route-")); folders.push(path); return path; }
async function project(): Promise<number> {
  const response = await fetch(`${harness!.base}/api/projects`, { method: "POST", body: JSON.stringify({ name: "Field", notes: "Keep my notes" }) });
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}
function select(id: number, path: string) { return fetch(`${harness!.base}/api/projects/${id}/import`, { method: "PUT", body: JSON.stringify({ path }) }); }

test("a loopback browser can ask whether folder import is available for an empty project", async () => {
  harness = openHarness();
  const project = await (await fetch(`${harness.base}/api/projects`, {
    method: "POST", body: JSON.stringify({ name: "Field", notes: "" }),
  })).json() as { id: number };
  const response = await fetch(`${harness.base}/api/projects/${project.id}/import`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    available: true, state: "none", path: null, acceptedCount: 0,
    skippedCount: 0, groundControlCount: 0, files: [], nextOffset: null,
  });
});

test("listing, facts, engine copy and project deletion leave the imported tree unchanged", async () => {
  harness = openHarness();
  const id = await project(), root = await scratch(), source = join(root, "source");
  await mkdir(source); await mkdir(join(source, "nested"));
  const first = detailedTiff(true), second = detailedTiff(true);
  second.write("2024:02:29 12:35:56\0", 310);
  await writeFile(join(source, "a.tif"), first); await writeFile(join(source, "duplicate.tif"), first);
  await writeFile(join(source, "nested", "b.tif"), second); await writeFile(join(source, "a_mask.jpg"), "mask");
  await writeFile(join(source, "video.mp4"), "video"); await writeFile(join(source, "gcp.txt"), "unsupported control");
  await writeFile(join(source, "other.zip"), "unsupported archive"); await symlink(join(source, "a.tif"), join(source, "linked.tif"));
  for (const name of ["a.tif", "duplicate.tif", "a_mask.jpg", "video.mp4", "gcp.txt", "other.zip", "nested/b.tif"]) await chmod(join(source, name), 0o444);
  await chmod(join(source, "nested"), 0o555); await chmod(source, 0o555);
  const before = await folderSnapshot(source);
  expect((await select(id, source)).status).toBe(200);
  const list = await (await fetch(`${harness.base}/api/projects/${id}/import?limit=2`)).json() as FolderImportView;
  expect(list).toMatchObject({ available: true, state: "ready", path: source, acceptedCount: 5, skippedCount: 2, groundControlCount: 1, nextOffset: 2 });
  expect(list.files).toHaveLength(2);
  const facts = await (await fetch(`${harness.base}/api/projects/${id}/photo-facts`)).json() as ProjectPhotoFactsView;
  expect(facts).toMatchObject({ photoCount: 2, photoBytes: 1024, duplicates: 1, videoCount: 1, withoutGps: 0, cameras: [{ make: null, model: "Model", photoCount: 2 }], flightCount: 1, pendingMetadata: 0 });
  expect((await fetch(`${harness.base}/api/projects/${id}/photos`)).status).toBe(200);
  const fake = new FakeTaskApi(); await fake.start();
  try {
    fake.onCommit = task => { task.statusCode = 40; };
    const engineId = harness.engineStore.addRemote({ name: "Engine", address: fake.address, token: fake.token }).id;
    const client = new TaskClient({ address: fake.address, token: fake.token });
    const created = await client.createTask("Imported field", []); expect(created.ok).toBe(true); if (!created.ok) throw new Error("Task creation failed");
    expect((await harness.ctx.imports.copyToTask(id, client, created.value.uuid)).ok).toBe(true);
    expect((await client.commitTask(created.value.uuid)).ok).toBe(true);
    expect(await client.taskInfo(created.value.uuid)).toMatchObject({ ok: true, value: { statusCode: 40 } });
    expect(fake.uploads).toHaveLength(4);
    const run = harness.runs.create({ projectId: id, engineId, options: [] });
    harness.runs.update(run.id, { taskUuid: created.value.uuid, state: "completed" });
    expect(await folderSnapshot(source)).toEqual(before);
    expect((await fetch(`${harness.base}/api/projects/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(fake.tasks.has(created.value.uuid)).toBe(false);
    expect(await folderSnapshot(source)).toEqual(before);
  } finally { await fake.stop(); }
});

test("missing and changed sources refuse facts, and relinking restores stored flight choices after reopening", async () => {
  const root = await scratch(), data = join(root, "data"), source = join(root, "photos"), moved = join(root, "moved");
  await mkdir(data); await mkdir(source); await writeFile(join(source, "a.tif"), detailedTiff(true));
  harness = openHarness({ dataFolder: data });
  const id = await project(); expect((await select(id, source)).status).toBe(200);
  const facts = await (await fetch(`${harness.base}/api/projects/${id}/photo-facts`)).json() as ProjectPhotoFactsView;
  expect((await fetch(`${harness.base}/api/projects/${id}/flights/${facts.flights[0]!.id}`, { method: "PUT", body: JSON.stringify({ excluded: true }) })).status).toBe(204);
  await rename(source, moved);
  expect(await (await fetch(`${harness.base}/api/projects/${id}/import`)).json()).toMatchObject({ state: "missing" });
  expect(await (await fetch(`${harness.base}/api/projects/${id}/photo-facts`)).json()).toMatchObject({ error: { code: "import.missing" } });
  expect((await select(id, moved)).status).toBe(200);
  await harness.stop(); harness = openHarness({ dataFolder: data });
  expect(await (await fetch(`${harness.base}/api/projects/${id}/photo-facts`)).json()).toMatchObject({ flights: [{ excludedPhotoCount: 1 }] });
  await writeFile(join(moved, "a.tif"), "changed content");
  expect(await (await fetch(`${harness.base}/api/projects/${id}/import`)).json()).toMatchObject({ state: "changed" });
  expect((await fetch(`${harness.base}/api/projects/${id}/photo-facts`)).status).toBe(409);
  expect((await select(id, moved)).status).toBe(200);
  expect(await (await fetch(`${harness.base}/api/projects/${id}/photo-facts`)).json()).toMatchObject({ photoCount: 1, unassignedCount: 1 });
});

lanTest("an authenticated remote browser cannot select a folder or learn its absolute path", async address => {
  harness = openHarness({ hostname: "0.0.0.0" });
  const id = await project(), source = await scratch(); await writeFile(join(source, "a.jpg"), "photo");
  expect((await select(id, source)).status).toBe(200);
  const passphrase = "folder-import-test";
  expect((await fetch(`${harness.base}/api/settings/lan`, { method: "PUT", body: JSON.stringify({ enabled: true, passphrase }) })).status).toBe(200);
  const remote = `http://${address}:${harness.port}`;
  const login = await fetch(`${remote}/api/auth/login`, { method: "POST", body: JSON.stringify({ passphrase }) });
  expect(login.status).toBe(204);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const headers = { cookie, "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" };
  expect(await (await fetch(`${remote}/api/projects/${id}/import`, { headers })).json()).toMatchObject({ available: false, state: "ready", path: null });
  const refused = await fetch(`${remote}/api/projects/${id}/import`, { method: "PUT", headers, body: JSON.stringify({ path: source }) });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: { code: "import.local_only" } });
});

test("an upload whose request body arrives after import cannot mix photo sources", async () => {
  harness = openHarness(); const id = await project(), source = await scratch();
  let complete: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    complete = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ name: "a.jpg", size: 1, sha256: "a".repeat(64) }))); controller.close(); };
  } });
  const request = Object.assign(new Request(`${harness.base}/api/projects/${id}/uploads`, { method: "POST", body }), { params: { id: String(id) } }) as unknown as Bun.BunRequest;
  const pending = projectRoutes(harness.ctx)["/api/projects/:id/uploads"]!.POST!(request, { client: { address: "127.0.0.1" }, server: {} as Bun.Server<undefined> });
  expect((await select(id, source)).status).toBe(200);
  complete!();
  const response = await pending;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "import.source_selected" } });
});

test("the version 7 upgrade retains uploaded content, cached facts and flight choices", async () => {
  const data = await scratch(), db = new Database(join(data, DATABASE_FILE));
  let id: number, flightId: string;
  try {
    db.run("PRAGMA foreign_keys = ON"); applyMigrations(db, migrations.slice(0, 7));
    id = (db.query("INSERT INTO projects (name, notes, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id").get("Existing field", "Keep these notes", "then", "then") as { id: number }).id;
    const bytes = detailedTiff(true), sha256 = createHash("sha256").update(bytes).digest("hex");
    const uploads = new UploadStore(db, data), photos = new PhotoStore(db, data);
    const session = uploads.create(id, { name: "a.tif", sha256, size: bytes.length });
    expect(await uploads.chunk(id, session.id, 0, sha256, new Response(new Uint8Array(bytes)).body)).toBe("ok");
    expect(await uploads.complete(id, session.id)).toBe("ok");
    flightId = (await photos.facts(id, 0, 50)).flights[0]!.id;
    expect(await photos.setFlightExcluded(id, flightId, true)).toBe("ok");
  } finally { db.close(); }
  const before = await folderSnapshot(join(data, "projects", String(id), "files"));
  harness = openHarness({ dataFolder: data });
  expect(await (await fetch(`${harness.base}/api/projects/${id}`)).json()).toMatchObject({ name: "Existing field", notes: "Keep these notes", photoCount: 1 });
  expect(await (await fetch(`${harness.base}/api/projects/${id}/photo-facts`)).json()).toMatchObject({ pendingMetadata: 0, flights: [{ id: flightId, excludedPhotoCount: 1 }] });
  expect(await (await fetch(`${harness.base}/api/projects/${id}/import`)).json()).toMatchObject({ state: "none" });
  expect(await folderSnapshot(join(data, "projects", String(id), "files"))).toEqual(before);
});
