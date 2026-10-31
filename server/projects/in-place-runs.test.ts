import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { CONTAINER_NAME, importedPath } from "../packages/container-package.ts";
import { detailedTiff } from "../../test-support/photo-metadata.ts";
import { afterEach, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskClient } from "../task-api/task-client.ts";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { folderSnapshot } from "../../test-support/import-folder.ts";
import { openHarness, eventually } from "../testing/harness.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("a same-machine engine reads the reviewed import in place without uploads", async () => {
  const api = new FakeTaskApi({ info: { version: "2.7.0", imagesPath: true } });
  await api.start(); cleanup.push(() => api.stop());
  const h = openHarness(); cleanup.push(() => h.stop());
  const folder = await mkdtemp(join(tmpdir(), "aidm-in-place-")); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, "one.jpg"), "one synthetic photo");
  const before = await folderSnapshot(folder);
  const project = h.ctx.projects.create("Field", "").id;
  const engine = h.engineStore.addRemote({ name: "Same machine", address: api.address, token: api.token }).id;
  expect((await fetch(`${h.base}/api/projects/${project}/import`, { method: "PUT", body: JSON.stringify({ path: folder }) })).status).toBe(200);
  const review = await (await fetch(`${h.base}/api/projects/${project}/run-review?engineId=${engine}&preset=quick-map`)).json();
  expect(review.importMode).toEqual({ selected: "in-place", available: true, restartRequired: false, selectionRequiresCopy: false });
  const response = await fetch(`${h.base}/api/projects/${project}/runs`, { method: "POST", body: JSON.stringify({ engineId: engine, preset: "quick-map", name: "Field", revision: review.revision }) });
  expect(response.status).toBe(202);
  const linking = await response.json();
  expect(linking.step).toBe("link"); expect(linking.upload).toBeNull();
  await eventually(async () => [...api.tasks.values()].some(task => task.committed));
  expect([...api.tasks.values()][0]?.imagesPath).toBe(folder);
  expect(api.uploads).toHaveLength(0);
  expect(await folderSnapshot(folder)).toEqual(before);
});


test("copy is an explicit alternative even when the engine supports in-place input", async () => {
  const api = new FakeTaskApi({ info: { imagesPath: true } }); await api.start(); cleanup.push(() => api.stop());
  const h = openHarness(); cleanup.push(() => h.stop());
  const folder = await mkdtemp(join(tmpdir(), "aidm-copy-choice-")); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, "one.jpg"), "one synthetic photo");
  const project = h.ctx.projects.create("Field", "").id;
  const engine = h.engineStore.addRemote({ name: "Same machine", address: api.address, token: api.token }).id;
  await fetch(`${h.base}/api/projects/${project}/import`, { method: "PUT", body: JSON.stringify({ path: folder }) });
  const body = { engineId: engine, preset: "quick-map", importMode: "copy" };
  const response = await fetch(`${h.base}/api/projects/${project}/run-review`, { method: "POST", body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  const review = await response.json();
  expect(review.importMode).toMatchObject({ selected: "copy", available: true });
  const started = await fetch(`${h.base}/api/projects/${project}/runs`, { method: "POST", body: JSON.stringify({ ...body, name: "Copied", revision: review.revision }) });
  expect(started.status).toBe(202);
  await eventually(async () => [...api.tasks.values()].some(task => task.committed));
  expect(api.uploads).toHaveLength(1);
  expect([...api.tasks.values()][0]?.imagesPath).toBeUndefined();
});


test("engine-created links do not mark an unchanged imported folder as changed", async () => {
  const api = new FakeTaskApi({ info: { imagesPath: true } }); await api.start(); cleanup.push(() => api.stop());
  const folder = await mkdtemp(join(tmpdir(), "aidm-import-link-")); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const taskFolder = await mkdtemp(join(tmpdir(), "aidm-task-link-")); cleanup.push(() => rm(taskFolder, { recursive: true, force: true }));
  const file = join(folder, "one.jpg"), linked = join(taskFolder, "one.jpg");
  await writeFile(file, "one synthetic photo");
  const before = await folderSnapshot(folder);
  const h = openHarness({ runClientFor: endpoint => new TaskClient(endpoint, { fetch: (async (input, init) => {
    const response = await fetch(input, init);
    if (new URL(String(input)).pathname === "/task/new/init") await link(file, linked);
    return response;
  }) as typeof fetch }) }); cleanup.push(() => h.stop());
  const project = h.ctx.projects.create("Field", "").id;
  const engine = h.engineStore.addRemote({ name: "Same machine", address: api.address, token: api.token }).id;
  await fetch(`${h.base}/api/projects/${project}/import`, { method: "PUT", body: JSON.stringify({ path: folder }) });
  const review = await (await fetch(`${h.base}/api/projects/${project}/run-review?engineId=${engine}&preset=quick-map`)).json();
  expect((await fetch(`${h.base}/api/projects/${project}/runs`, { method: "POST", body: JSON.stringify({ engineId: engine, preset: "quick-map", name: "Field", revision: review.revision }) })).status).toBe(202);
  await eventually(async () => [...api.tasks.values()].some(task => task.committed));
  await unlink(linked);
  const imported = await (await fetch(`${h.base}/api/projects/${project}/import`)).json();
  expect(imported.state).toBe("ready");
  const after = await folderSnapshot(folder);
  expect(after[0]).toEqual(before[0]);
  // The kernel changes file ctime when a hard link is added or removed.
  expect(after.map(({ changed, ...entry }) => entry)).toEqual(before.map(({ changed, ...entry }) => entry));
});


test.each(["unreported", "nested", "excluded", "remote"] as const)("%s input uses a copy instead of sending a folder the engine cannot use", async reason => {
  const api = new FakeTaskApi({ info: reason === "unreported" ? {} : { imagesPath: true } }); await api.start(); cleanup.push(() => api.stop());
  const h = openHarness({ runClientFor: endpoint => new TaskClient({ address: api.address, token: endpoint.token }) }); cleanup.push(() => h.stop());
  const folder = await mkdtemp(join(tmpdir(), "aidm-import-fallback-")); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, "one.jpg"), "one synthetic photo");
  if (reason === "nested") { await mkdir(join(folder, "nested")); await writeFile(join(folder, "nested/two.jpg"), "another synthetic photo"); }
  if (reason === "excluded") {
    await unlink(join(folder, "one.jpg"));
    const first = detailedTiff(true), second = Buffer.from(first);
    second.write("2024:02:29 14:34:56", 310);
    await writeFile(join(folder, "one.tif"), first); await writeFile(join(folder, "two.tif"), second);
  }
  const project = h.ctx.projects.create("Field", "").id;
  const engine = h.engineStore.addRemote({ name: "Chosen engine", address: reason === "remote" ? "https://engine.example.invalid" : api.address, token: api.token }).id;
  await fetch(`${h.base}/api/projects/${project}/import`, { method: "PUT", body: JSON.stringify({ path: folder }) });
  if (reason === "excluded") {
    const facts = await (await fetch(`${h.base}/api/projects/${project}/photo-facts`)).json();
    expect((await fetch(`${h.base}/api/projects/${project}/flights/${facts.flights[0].id}`, { method: "PUT", body: JSON.stringify({ excluded: true }) })).status).toBe(204);
  }
  const review = await (await fetch(`${h.base}/api/projects/${project}/run-review?engineId=${engine}&preset=quick-map`)).json();
  expect(review.importMode).toMatchObject({ selected: "copy", available: false, restartRequired: false });
  const started = await fetch(`${h.base}/api/projects/${project}/runs`, { method: "POST", body: JSON.stringify({ engineId: engine, preset: "quick-map", name: "Copied", revision: review.revision }) });
  expect(started.status).toBe(202);
  await eventually(async () => [...api.tasks.values()].some(task => task.committed));
  expect([...api.tasks.values()][0]?.imagesPath).toBeUndefined();
  expect(api.uploads.length).toBe(reason === "nested" ? 2 : 1);
});

test("a ctime-only change still detects changed bytes even when modification time was restored", async () => {
  const h = openHarness(); cleanup.push(() => h.stop());
  const folder = await mkdtemp(join(tmpdir(), "aidm-import-drift-")); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "one.jpg"), time = new Date("2024-01-01T00:00:00Z");
  await writeFile(file, "first photo"); await utimes(file, time, time);
  const project = h.ctx.projects.create("Field", "").id;
  await fetch(`${h.base}/api/projects/${project}/import`, { method: "PUT", body: JSON.stringify({ path: folder }) });
  await writeFile(file, "other photo"); await utimes(file, time, time);
  expect((await (await fetch(`${h.base}/api/projects/${project}/import`)).json()).state).toBe("changed");
});


test("a local import start uses the restarted container address and its read-only folder path", async () => {
  const runtime = new FakeRuntime({ versionOf: () => "2.7.0" });
  const h = openHarness({ runtimes: { podman: runtime } }); cleanup.push(() => h.stop());
  const digest = `sha256:${"a".repeat(64)}`, image = "ghcr.io/aidronemap/aidm-api";
  runtime.holdImage(`${image}@${digest}`);
  const engine = h.engineStore.addLocal({ name: "This computer", token: "import-test-token", packageKind: "container", installedVersion: "2.7.0" }).id;
  h.settings.set("local.package", { packageVersion: "2.7.0", variant: "linux-amd64-cpu", runtime: "podman", container: { kind: "container", image, digest, size: 100, gpu: false } });
  expect((await h.localEngine.start()).ok).toBe(true);
  const folder = await mkdtemp(join(tmpdir(), "aidm-local-import-")); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, "one.jpg"), "one synthetic photo");
  const original = await folderSnapshot(folder);
  const project = h.ctx.projects.create("Field", "").id;
  await fetch(`${h.base}/api/projects/${project}/import`, { method: "PUT", body: JSON.stringify({ path: folder }) });
  const review = await (await fetch(`${h.base}/api/projects/${project}/run-review?engineId=${engine}&preset=quick-map`)).json();
  expect(review.importMode).toMatchObject({ selected: "in-place", restartRequired: true });
  const starts = runtime.starts.length;
  const response = await fetch(`${h.base}/api/projects/${project}/runs`, { method: "POST", body: JSON.stringify({ engineId: engine, preset: "quick-map", name: "Field", revision: review.revision }) });
  expect(response.status).toBe(202);
  await eventually(async () => [...(runtime.engine(CONTAINER_NAME)?.tasks.values() ?? [])].some(task => task.committed));
  expect(runtime.starts).toHaveLength(starts + 1);
  const run = await response.json();
  const api = runtime.engine(CONTAINER_NAME)!;
  expect([...api.tasks.values()][0]?.imagesPath).toBe(importedPath(folder));
  expect(api.uploads).toHaveLength(0);
  expect(await folderSnapshot(folder)).toEqual(original);
  api.setTask([...api.tasks.keys()][0]!, { statusCode: 30 });
  await eventually(async () => h.runs.get(run.id)?.state === "failed");
  h.settings.set("local.importFolders", []);
  expect((await h.localEngine.start()).ok).toBe(true);
  const repeated = await fetch(`${h.base}/api/runs/${run.id}/retry`, { method: "POST" });
  expect(repeated.status).toBe(202);
  const retry = await repeated.json();
  await eventually(async () => h.runs.get(retry.id)?.state === "queued");
  expect(runtime.engine(CONTAINER_NAME)!.uploads).toHaveLength(0);
  expect([...runtime.engine(CONTAINER_NAME)!.tasks.values()][0]?.imagesPath).toBe(importedPath(folder));
});
