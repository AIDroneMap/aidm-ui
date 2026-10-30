import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveAsset } from "../server/http/static-assets.ts";
import { withSecurityHeaders } from "../server/http/security-headers.ts";
import { texturedGlb } from "./textured-glb.ts";
import { assertArchivedModel, modelAcceptanceAssets } from "./model-acceptance.ts";

test("accepts a textured model and rejects an invalid GLB", async () => {
  const folder = await mkdtemp(join(tmpdir(), "model-assets-"));
  let invalid = false;
  const assets = await modelAcceptanceAssets(folder);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/runs/77/outputs/glb") return withSecurityHeaders(new Response(invalid ? new Uint8Array([103, 108, 84, 70, 10]) : texturedGlb()));
    return withSecurityHeaders(serveAsset(assets, path) ?? new Response(null, { status: 404 }));
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const result = await assertArchivedModel(base, 77);
    expect(result.outputRequests).toBeGreaterThan(0);
    expect(result.coloredPixels).toBeGreaterThan(0);
    expect(result.externalRequests).toEqual([]);
    invalid = true;
    await expect(assertArchivedModel(base, 77)).rejects.toThrow("The 3D model could not be opened.");
  } finally {
    server.stop(true);
    await rm(folder, { recursive: true, force: true });
  }
}, 60000);

test("renders a retained archive through the guarded output route", async () => {
  const { openHarness, eventually } = await import("../server/testing/harness.ts");
  const { FakeTaskApi } = await import("./fake-task-api.ts");
  const { TaskClient } = await import("../server/task-api/task-client.ts");
  const { writeStoredZip } = await import("./stored-zip-writer.ts");
  const folder = await mkdtemp(join(tmpdir(), "model-route-assets-"));
  const fake = new FakeTaskApi();
  await fake.start();
  const h = openHarness({ assets: await modelAcceptanceAssets(folder), runPollMs: 20 });
  try {
    const engine = h.engineStore.addRemote({ name: "Field", address: fake.address, token: fake.token });
    const project = h.ctx.projects.create("Field", "");
    const task = await new TaskClient({ address: fake.address, token: fake.token }).createTask("Field", []);
    if (!task.ok) throw new Error("Task creation failed");
    const archivePath = join(folder, "results.zip");
    writeStoredZip(archivePath, [{ name: "odm_texturing/odm_textured_model_geo.glb", data: texturedGlb() }]);
    fake.setTask(task.value.uuid, { statusCode: 40, processingTime: 1, output: ["Finished"], results: new Uint8Array(await Bun.file(archivePath).arrayBuffer()) });
    const run = h.runs.create({ projectId: project.id, engineId: engine.id, options: [] });
    h.runs.update(run.id, { taskUuid: task.value.uuid, state: "queued" });
    h.tracker.follow(run.id);
    await eventually(async () => (await (await fetch(`${h.base}/api/runs/${run.id}`)).json()).resultsAvailable);
    const result = await assertArchivedModel(h.base, run.id);
    expect(result.outputRequests).toBeGreaterThan(0);
    expect(result.coloredPixels).toBeGreaterThan(0);
    expect(result.externalRequests).toEqual([]);
  } finally {
    await h.stop();
    await fake.stop();
    await rm(folder, { recursive: true, force: true });
  }
}, 60000);
