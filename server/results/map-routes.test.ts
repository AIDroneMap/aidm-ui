import { afterEach, expect, test } from "bun:test";
import { openHarness, type Harness } from "../testing/harness.ts";

let h: Harness;
afterEach(async () => { await h?.stop(); });
test("map metadata reports absent results without contacting an engine", async () => {
  h = openHarness();
  const project = h.ctx.projects.create("Field", "");
  const engine = h.engineStore.addRemote({ name: "Field", address: "http://127.0.0.1:9", token: "test" });
  const run = h.runs.create({ projectId: project.id, engineId: engine.id, options: [] });
  const response = await fetch(`${h.base}/api/runs/${run.id}/map`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "unavailable", layers: [] });
  expect((await fetch(`${h.base}/api/runs/99999/map`)).status).toBe(404);
});

function raster(): Uint8Array {
  const tags: Array<[number, number, number[]]> = [
    [256, 4, [4]], [257, 4, [4]],
    [33550, 12, [.001, .001, 0]],
    [33922, 12, [0, 0, 0, -91.996, 46.845, 0]],
    [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]],
  ];
  const bytes = Buffer.alloc(512); bytes.write("II"); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4); bytes.writeUInt16LE(tags.length, 8);
  let data = 8 + 2 + tags.length * 12 + 4;
  tags.forEach(([tag, type, values], i) => {
    const p = 10 + i * 12; bytes.writeUInt16LE(tag, p); bytes.writeUInt16LE(type, p + 2); bytes.writeUInt32LE(values.length, p + 4);
    const width = type === 12 ? 8 : type === 4 ? 4 : 2;
    const offset = values.length * width <= 4 ? p + 8 : data;
    if (offset === data) { bytes.writeUInt32LE(data, p + 8); data += values.length * width; }
    values.forEach((value, j) => { if (type === 12) bytes.writeDoubleLE(value, offset + j * width); else if (type === 4) bytes.writeUInt32LE(value, offset + j * width); else bytes.writeUInt16LE(value, offset + j * width); });
  });
  return bytes;
}

import { join } from "node:path";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { TaskClient } from "../task-api/task-client.ts";
import { eventually } from "../testing/harness.ts";
import type { RunMapView } from "../../shared/map.ts";
let fake: FakeTaskApi;
afterEach(async () => { await fake?.stop(); });
async function readyArchive(files: Array<{ name: string; data: Uint8Array }>) {
  fake = new FakeTaskApi(); await fake.start(); h = openHarness({ runPollMs: 20 });
  const engine = h.engineStore.addRemote({ name: "Field", address: fake.address, token: fake.token });
  const project = h.ctx.projects.create("Field", "");
  const client = new TaskClient({ address: fake.address, token: fake.token });
  const task = await client.createTask("Field", []); if (!task.ok) throw new Error("fixture task creation");
  const archive = join(h.dataFolder, "map-fixture.zip"); writeStoredZip(archive, files);
  fake.setTask(task.value.uuid, { statusCode: 40, results: new Uint8Array(await Bun.file(archive).arrayBuffer()) });
  const run = h.runs.create({ projectId: project.id, engineId: engine.id, options: [] });
  h.runs.update(run.id, { taskUuid: task.value.uuid, state: "queued" }); h.tracker.follow(run.id);
  await eventually(async () => h.tracker.view(run.id)?.resultsAvailable === true);
  return run;
}
const png = new Uint8Array([137, 80, 78, 71]);
test("map uses archived raster bounds, detects TMS tiles and omits absent elevation layers", async () => {
  const run = await readyArchive([
    { name: "odm_orthophoto/odm_orthophoto.tif", data: raster() },
    { name: "orthophoto_tiles/16/16020/42443.png", data: png },
    { name: "dsm_tiles/16/16020/42443.png", data: png },
    { name: "orthophoto_tiles/tilemapresource.xml", data: new TextEncoder().encode('<BoundingBox minx="0" miny="0" maxx="1" maxy="1"/>') },
  ]);
  await fake.stop();
  const response = await fetch(`${h.base}/api/runs/${run.id}/map`); expect(response.status).toBe(200);
  const view = await response.json() as RunMapView;
  expect(view.state).toBe("ready"); expect(view.layers).toHaveLength(1);
  expect(view.layers[0]).toMatchObject({ name: "orthophoto", scheme: "tms", minZoom: 16, maxZoom: 16 });
  const bounds = view.layers[0]!.bounds;
  [-91.996, 46.841, -91.992, 46.845].forEach((value, i) => expect(bounds[i]).toBeCloseTo(value, 8));
  expect(new Uint8Array(await (await fetch(`${h.base}/api/runs/${run.id}/tiles/orthophoto/16/16020/42443.png`)).arrayBuffer())).toEqual(png);
  await fetch(`${h.base}/api/runs/${run.id}/results`, { method: "DELETE" });
  expect(await (await fetch(`${h.base}/api/runs/${run.id}/map`)).json()).toEqual({ state: "unavailable", layers: [] });
});

test.each([false, true])("current XYZ layers use primary georeferencing with overviews %s", async overviews => {
  const image = Buffer.from(raster());
  if (overviews) {
    image.writeUInt32LE(400, 10 + image.readUInt16LE(8) * 12);
    image.writeUInt16LE(1, 400);
    image.writeUInt16LE(256, 402); image.writeUInt16LE(4, 404);
    image.writeUInt32LE(1, 406); image.writeUInt32LE(2, 410);
  }
  const run = await readyArchive([
    { name: "odm_orthophoto/odm_orthophoto.tif", data: image },
    { name: "odm_dem/dsm.tif", data: image },
    { name: "odm_dem/dtm.tif", data: image },
    { name: "orthophoto_tiles/16/16020/23092.png", data: png },
    { name: "dsm_tiles/16/16020/23092.png", data: png },
    { name: "dtm_tiles/16/16020/23092.png", data: png },
  ]);
  const view = await (await fetch(`${h.base}/api/runs/${run.id}/map`)).json() as RunMapView;
  expect(view.state).toBe("ready");
  expect(view.layers.map(layer => [layer.name, layer.scheme])).toEqual([["orthophoto", "xyz"], ["surface", "xyz"], ["ground", "xyz"]]);
});

test("tiles without usable result georeferencing and tiles outside the raster stay unavailable", async () => {
  const run = await readyArchive([
    { name: "odm_orthophoto/odm_orthophoto.tif", data: new Uint8Array([0]) },
    { name: "odm_dem/dsm.tif", data: raster() },
    { name: "orthophoto_tiles/16/16020/42443.png", data: png },
    { name: "dsm_tiles/16/0/0.png", data: png },
    { name: "dtm_tiles/16/16020/42443.png", data: png },
  ]);
  expect(await (await fetch(`${h.base}/api/runs/${run.id}/map`)).json()).toEqual({ state: "unavailable", layers: [] });
});
