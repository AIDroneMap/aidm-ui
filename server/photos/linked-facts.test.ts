import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { readLinkedPhotoFacts } from "./linked-facts.ts";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

async function archive(data: string, name = "images.json"): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "linked-facts-"));
  folders.push(folder);
  const path = join(folder, "results.zip");
  writeStoredZip(path, [{ name, data: new TextEncoder().encode(data) }]);
  return path;
}

test("aggregates facts from retained image metadata", async () => {
  const path = await archive(JSON.stringify([
    { filename: "one.jpg", camera_make: "DJI", camera_model: "FC300S", width: 4000, height: 2250, latitude: 0, longitude: 0, path_file: "/private/one.jpg" },
    { filename: "two.jpg", camera_make: "DJI", camera_model: "FC300S", width: 4000, height: 2250 },
  ]));
  expect(await readLinkedPhotoFacts(path)).toEqual({
    photoCount: 2, withoutGps: 1,
    cameras: [{ make: "DJI", model: "FC300S", photoCount: 2 }],
    dimensions: [{ width: 4000, height: 2250, photoCount: 2 }],
  });
});

test("accepts missing metadata without inventing groups", async () => {
  const path = await archive(JSON.stringify([{ filename: "photo.jpg", make_model: "uncertain" }]));
  expect(await readLinkedPhotoFacts(path)).toEqual({ photoCount: 1, withoutGps: 1, cameras: [], dimensions: [] });
});

test("requires unique, safe filenames and valid metadata in every record", async () => {
  const invalid = [
    {}, [null], [42], [{}], [{ filename: "../photo.jpg" }],
    [{ filename: "same.jpg" }, { filename: "same.jpg" }],
    [{ filename: "photo.jpg", camera_make: "x".repeat(257) }],
    [{ filename: "photo.jpg", camera_model: 4 }],
    [{ filename: "photo.jpg", width: -1 }], [{ filename: "photo.jpg", height: 1.5 }],
    [{ filename: "photo.jpg", latitude: 91 }], [{ filename: "photo.jpg", longitude: "0" }],
  ];
  for (const value of invalid) expect(await readLinkedPhotoFacts(await archive(JSON.stringify(value)))).toBeNull();
});

test("rejects missing, invalid and oversized metadata", async () => {
  expect(await readLinkedPhotoFacts(await archive("[]", "other.json"))).toBeNull();
  expect(await readLinkedPhotoFacts(await archive("{"))).toBeNull();
  expect(await readLinkedPhotoFacts(await archive(" ".repeat(16 * 1024 * 1024 + 1)))).toBeNull();
  expect(await readLinkedPhotoFacts(await archive(JSON.stringify(Array.from({ length: 100_001 }, () => ({ filename: "a" })))))).toBeNull();
  expect(await readLinkedPhotoFacts("/missing/archive.zip")).toBeNull();
});

test("reads a deflated entry and rejects a false uncompressed size", async () => {
  const data = Buffer.from(JSON.stringify([{ filename: "one.jpg", latitude: 0, longitude: 0 }]));
  const path = await archive(data.toString());
  const stored = await readFile(path);
  const nameLength = stored.readUInt16LE(26);
  const bodyStart = 30 + nameLength;
  const centralStart = stored.readUInt32LE(stored.length - 6);
  const compressed = deflateRawSync(data);
  const zip = Buffer.concat([stored.subarray(0, bodyStart), compressed, stored.subarray(centralStart)]);
  const central = bodyStart + compressed.length;
  zip.writeUInt16LE(8, 8); zip.writeUInt16LE(8, central + 10);
  zip.writeUInt32LE(compressed.length, 18); zip.writeUInt32LE(compressed.length, central + 20);
  zip.writeUInt32LE(central, zip.length - 6);
  await writeFile(path, zip);
  expect(await readLinkedPhotoFacts(path)).toEqual({ photoCount: 1, withoutGps: 0, cameras: [], dimensions: [] });
  zip.writeUInt32LE(1, 22); zip.writeUInt32LE(1, central + 24);
  await writeFile(path, zip);
  expect(await readLinkedPhotoFacts(path)).toBeNull();
});

test("rejects multiple images.json entries", async () => {
  const path = await archive("[]");
  writeStoredZip(path, [{ name: "images.json", data: Buffer.from("[]") }, { name: "images.json", data: Buffer.from("[]") }]);
  expect(await readLinkedPhotoFacts(path)).toBeNull();
});

test("bounds the number of metadata groups returned to the page", async () => {
  const records = Array.from({ length: 257 }, (_, index) => ({ filename: `photo-${index}.jpg`, camera_model: `Camera ${index}`, width: 1000 + index, height: 1000 }));
  expect(await readLinkedPhotoFacts(await archive(JSON.stringify(records)))).toBeNull();
});
