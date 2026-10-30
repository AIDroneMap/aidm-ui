import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { readGeoreference } from "./georeference.ts";
import type { ArchiveEntry } from "./zip.ts";

function fixture(): Buffer {
  const data = Buffer.alloc(256);
  data.write("II"); data.writeUInt16LE(42, 2); data.writeUInt32LE(8, 4);
  data.writeUInt16LE(5, 8);
  const tags = [[256, 4, 1, 2], [257, 4, 1, 3], [33550, 12, 3, 80], [33922, 12, 6, 104], [34735, 3, 12, 152]];
  for (const [index, tag] of tags.entries()) {
    const pos = 10 + index * 12;
    data.writeUInt16LE(tag[0]!, pos); data.writeUInt16LE(tag[1]!, pos + 2);
    data.writeUInt32LE(tag[2]!, pos + 4); data.writeUInt32LE(tag[3]!, pos + 8);
  }
  [1, 1, 0].forEach((value, index) => data.writeDoubleLE(value, 80 + index * 8));
  [0, 0, 0, 10, 20, 0].forEach((value, index) => data.writeDoubleLE(value, 104 + index * 8));
  [1, 1, 0, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326].forEach((value, index) => data.writeUInt16LE(value, 152 + index * 2));
  return data;
}

async function read(data: Buffer, method: 0 | 8 = 0) {
  const folder = await mkdtemp(join(tmpdir(), "georef-"));
  const path = join(folder, "archive");
  const body = method === 8 ? deflateRawSync(data) : data;
  const entry: ArchiveEntry = { name: "image.tif", offset: 7, size: data.length, compressedSize: body.length, method, crc32: 0 };
  try { await writeFile(path, Buffer.concat([Buffer.alloc(7), body])); return await readGeoreference(path, entry); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

test("reads geographic bounds from stored and deflated raster metadata", async () => {
  for (const method of [0, 8] as const) expect(await read(fixture(), method)).toEqual({ bounds: [10, 17, 12, 20], epsg: 4326 });
});

test("pixel points extend half a pixel around the samples", async () => {
  const data = fixture();
  data.writeUInt16LE(2, 166);
  expect(await read(data)).toEqual({ bounds: [9.5, 17.5, 11.5, 20.5], epsg: 4326 });
});

test("converts the primary orthophoto's UTM metadata", async () => {
  const data = fixture();
  data.writeUInt32LE(212, 18); data.writeUInt32LE(212, 30);
  data.writeDoubleLE(0.5003290000000423, 80); data.writeDoubleLE(0.5001358962266372, 88);
  data.writeDoubleLE(576667.262871, 128); data.writeDoubleLE(5188223.1477, 136);
  data.writeUInt16LE(3072, 168); data.writeUInt16LE(32615, 174);
  const result = await read(data);
  expect(result?.epsg).toBe(32615);
  // Independent corner transformation with Proj4js 2.15.0, using the fixture's literal UTM tags.
  const expected = [-91.99451323800885, 46.842167553856164, -91.9931045333495, 46.843133788493624];
  expected.forEach((value, index) => expect(result!.bounds[index]!).toBeCloseTo(value, 7));
});

test("reads big-endian BigTIFF metadata", async () => {
  const data = Buffer.alloc(320);
  data.write("MM"); data.writeUInt16BE(43, 2); data.writeUInt16BE(8, 4); data.writeBigUInt64BE(16n, 8);
  data.writeBigUInt64BE(5n, 16);
  const tags = [[256, 4, 1, 2], [257, 4, 1, 3], [33550, 12, 3, 144], [33922, 12, 6, 168], [34735, 3, 12, 216]];
  for (const [index, tag] of tags.entries()) {
    const pos = 24 + index * 20;
    data.writeUInt16BE(tag[0]!, pos); data.writeUInt16BE(tag[1]!, pos + 2); data.writeBigUInt64BE(BigInt(tag[2]!), pos + 4);
    if (index < 2) data.writeUInt32BE(tag[3]!, pos + 12); else data.writeBigUInt64BE(BigInt(tag[3]!), pos + 12);
  }
  [1, 1, 0].forEach((value, index) => data.writeDoubleBE(value, 144 + index * 8));
  [0, 0, 0, 10, 20, 0].forEach((value, index) => data.writeDoubleBE(value, 168 + index * 8));
  [1, 1, 0, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326].forEach((value, index) => data.writeUInt16BE(value, 216 + index * 2));
  for (const method of [0, 8] as const) expect(await read(data, method)).toEqual({ bounds: [10, 17, 12, 20], epsg: 4326 });
});

test("converts Web Mercator coordinates", async () => {
  const data = fixture();
  data.writeUInt32LE(1, 18); data.writeUInt32LE(1, 30);
  data.writeDoubleLE(1113194.9079327357, 80); data.writeDoubleLE(1118889.9748579594, 88);
  data.writeDoubleLE(0, 128); data.writeDoubleLE(1118889.9748579594, 136);
  data.writeUInt16LE(3072, 168); data.writeUInt16LE(3857, 174);
  const result = await read(data);
  expect(result?.epsg).toBe(3857);
  [0, 0, 10, 10].forEach((value, index) => expect(result!.bounds[index]!).toBeCloseTo(value, 8));
});

test("rejects unsupported CRS, conflicting tags, and invalid extents", async () => {
  const unsupported = fixture(); unsupported.writeUInt16LE(4269, 174);
  const conflict = fixture(); conflict.writeUInt16LE(34264, 46);
  const invalid = fixture(); invalid.writeDoubleLE(200, 128);
  for (const data of [unsupported, conflict, invalid]) expect(await read(data)).toBeNull();
});

test("rejects truncated and out-of-range metadata", async () => {
  const offset = fixture(); offset.writeUInt32LE(0xfffffff0, 42);
  const count = fixture(); count.writeUInt16LE(257, 8);
  for (const data of [fixture().subarray(0, 100), offset, count]) {
    for (const method of [0, 8] as const) expect(await read(data, method)).toBeNull();
  }
});
