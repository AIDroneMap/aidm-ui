import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStoredZip } from "../../test-support/stored-zip-writer.ts";
import { readStoredZip, ZipFormatError } from "./stored-zip.ts";

let folder = "";
beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "aidm-zip-"));
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function bytes(seed: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 7 + seed) & 0xff);
}

const files = [
  { name: "a.JPG", data: bytes(1, 1000) },
  { name: "b.JPG", data: bytes(2, 70_000) },
  { name: "empty.JPG", data: new Uint8Array(0) },
  { name: "c.JPG", data: bytes(3, 5) },
];

test("lists the files of a stored zip with the place of their bytes", async () => {
  const path = join(folder, "stored.zip");
  writeStoredZip(path, files);
  const entries = await readStoredZip(path);
  expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
  const all = new Uint8Array(await Bun.file(path).arrayBuffer());
  for (const [index, entry] of entries.entries()) {
    const expected = files[index]!.data;
    expect(entry.size).toBe(expected.length);
    expect(Buffer.compare(all.subarray(entry.offset, entry.offset + entry.size), expected)).toBe(0);
  }
});

test("a zip written by the helper is readable by real tools", async () => {
  const python = Bun.spawnSync(["python3", "--version"]);
  if (python.exitCode !== 0) return;
  const path = join(folder, "tools.zip");
  writeStoredZip(path, files);
  const listing = Bun.spawnSync(["python3", "-I", "-m", "zipfile", "-l", path]);
  expect(listing.exitCode).toBe(0);
  const text = listing.stdout.toString();
  for (const file of files) expect(text).toContain(file.name);
  const test = Bun.spawnSync(["python3", "-I", "-m", "zipfile", "-t", path]);
  expect(test.exitCode).toBe(0);
});

test("skips folder entries", async () => {
  const path = join(folder, "dirs.zip");
  writeStoredZip(path, [
    { name: "photos/", data: new Uint8Array(0) },
    { name: "photos/x.JPG", data: bytes(4, 10) },
  ]);
  const entries = await readStoredZip(path);
  expect(entries.map((e) => e.name)).toEqual(["photos/x.JPG"]);
});

test("a deflated zip is refused", async () => {
  const python = Bun.spawnSync(["python3", "--version"]);
  if (python.exitCode !== 0) return;
  const source = join(folder, "source.txt");
  writeFileSync(source, "hello hello hello hello hello hello hello hello\n".repeat(50));
  const path = join(folder, "deflated.zip");
  const made = Bun.spawnSync([
    "python3", "-I", "-c",
    "import sys, zipfile\n" +
      "z = zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED)\n" +
      "z.write(sys.argv[2], 'source.txt')\n" +
      "z.close()\n",
    path, source,
  ]);
  expect(made.exitCode).toBe(0);
  await expect(readStoredZip(path)).rejects.toBeInstanceOf(ZipFormatError);
});

test("a truncated file is refused", async () => {
  const path = join(folder, "truncated.zip");
  writeStoredZip(path, files);
  truncateSync(path, 200);
  await expect(readStoredZip(path)).rejects.toBeInstanceOf(ZipFormatError);
  const tiny = join(folder, "tiny.zip");
  writeFileSync(tiny, "PK");
  await expect(readStoredZip(tiny)).rejects.toBeInstanceOf(ZipFormatError);
});
