import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { geoTiffFixture } from "../../test-support/geotiff-fixture.ts";
import { readMapMetadata } from "./map-metadata.ts";
import type { ArchiveEntry } from "./zip.ts";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

/** An archive file holding the given members back to back, with the entries a reader would index. */
async function archive(members: Array<{ name: string; data: Uint8Array; method?: 0 | 8 }>): Promise<{ path: string; entries: ArchiveEntry[] }> {
  const folder = await mkdtemp(join(tmpdir(), "map-metadata-")); folders.push(folder);
  const parts: Buffer[] = []; const entries: ArchiveEntry[] = [];
  let offset = 0;
  for (const { name, data, method = 0 } of members) {
    const body = method === 8 ? deflateRawSync(data) : Buffer.from(data);
    entries.push({ name, offset, size: data.length, compressedSize: body.length, method, crc32: 0 });
    parts.push(body); offset += body.length;
  }
  const path = join(folder, "results.zip");
  await writeFile(path, Buffer.concat(parts));
  return { path, entries };
}

const ORTHOPHOTO = "odm_orthophoto/odm_orthophoto.tif";
const png = new Uint8Array([137, 80, 78, 71]);

test("an orthophoto without tiles is a GeoTIFF layer with its corners", async () => {
  const { path, entries } = await archive([{ name: ORTHOPHOTO, data: geoTiffFixture() }]);
  const view = await readMapMetadata(path, entries);
  expect(view.state).toBe("ready");
  expect(view.layers).toHaveLength(1);
  const layer = view.layers[0]!;
  if (layer.kind !== "cog") throw new Error(`Expected a GeoTIFF layer, got ${layer.kind}`);
  expect(layer.name).toBe("orthophoto");
  const [topLeft, topRight, bottomRight, bottomLeft] = layer.corners;
  expect(topLeft[0]).toBeLessThan(topRight[0]); expect(bottomLeft[1]).toBeLessThan(topLeft[1]);
  expect(bottomRight[0]).toBeCloseTo(topRight[0], 4); expect(bottomRight[1]).toBeCloseTo(bottomLeft[1], 4);
  const xs = layer.corners.map(point => point[0]), ys = layer.corners.map(point => point[1]);
  expect(layer.bounds).toEqual([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
});

test("an orthophoto with tiles is a tiles layer, and elevation models never become GeoTIFF layers", async () => {
  const image = geoTiffFixture();
  const tiled = await archive([
    { name: ORTHOPHOTO, data: image },
    { name: "odm_dem/dsm.tif", data: image },
    { name: "orthophoto_tiles/0/0/0.png", data: png },
  ]);
  expect((await readMapMetadata(tiled.path, tiled.entries)).layers.map(layer => [layer.kind, layer.name])).toEqual([["tiles", "orthophoto"]]);
});

test("a deflated orthophoto entry, which cannot answer range requests, gives no GeoTIFF layer", async () => {
  const { path, entries } = await archive([{ name: ORTHOPHOTO, data: geoTiffFixture(), method: 8 }]);
  expect(await readMapMetadata(path, entries)).toEqual({ state: "unavailable", layers: [] });
});
