import { afterEach, expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { entryBody, readArchive } from "./zip";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

async function archivePath(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "archive-test-"));
  folders.push(folder);
  return join(folder, "results.zip");
}

function fixture(name = "file.txt", method: 0 | 8 = 0): Buffer {
  const filename = Buffer.from(name);
  const body = method === 8 ? deflateRawSync(Buffer.from("hello")) : Buffer.from("hello");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(0x3610a686, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(5, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
  central.writeUInt32LE(0x3610a686, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(5, 24); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + filename.length, 12); end.writeUInt32LE(30 + filename.length + body.length, 16);
  return Buffer.concat([local, filename, body, central, filename, end]);
}

test("reads a stored entry from an archive file", async () => {
  const folder = await mkdtemp(join(tmpdir(), "archive-test-"));
  folders.push(folder);
  const path = join(folder, "results.zip");
  await writeFile(path, Buffer.from("504b03041400000000000000000086a6103605000000050000000800000066696c652e74787468656c6c6f504b010214001400000000000000000086a61036050000000500000008000000000000000000000000000000000066696c652e747874504b05060000000001000100360000002b0000000000", "hex"));
  const entries = await readArchive(path);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.name).toBe("file.txt");
  expect(await new Response(entryBody(path, entries[0]!)).text()).toBe("hello");
});

test("streams deflated entries and rejects damaged compressed data", async () => {
  const path = await archivePath();
  const data = fixture("file.txt", 8);
  await writeFile(path, data);
  const [entry] = await readArchive(path);
  expect(await new Response(entryBody(path, entry!)).text()).toBe("hello");
  data[39] = data[39]! ^ 0xff;
  await writeFile(path, data);
  await expect(readArchive(path)).rejects.toThrow();
});

test("rejects unsafe names, inconsistent headers and bad CRCs", async () => {
  const path = await archivePath();
  for (const name of ["../file", "/file", "a\\file", "a/../file"]) {
    await writeFile(path, fixture(name));
    await expect(readArchive(path)).rejects.toThrow();
  }
  const mismatch = fixture();
  mismatch[30] = 0x78;
  await writeFile(path, mismatch);
  await expect(readArchive(path)).rejects.toThrow();
  const corrupt = fixture();
  corrupt[38] = 0x78;
  await writeFile(path, corrupt);
  await expect(readArchive(path)).rejects.toThrow();
});

test("rejects bytes after a deflate stream and invalid data descriptors", async () => {
  const path = await archivePath();
  const original = fixture("file.txt", 8);
  const centralOffset = original.readUInt32LE(original.length - 6);
  const trailing = Buffer.concat([original.subarray(0, centralOffset), Buffer.from([0]), original.subarray(centralOffset)]);
  trailing.writeUInt32LE(8, 18);
  trailing.writeUInt32LE(8, centralOffset + 1 + 20);
  trailing.writeUInt32LE(centralOffset + 1, trailing.length - 6);
  await writeFile(path, trailing);
  await expect(readArchive(path)).rejects.toThrow();
  const descriptor = fixture();
  descriptor.writeUInt16LE(8, 6);
  descriptor.writeUInt16LE(8, 43 + 8);
  await writeFile(path, descriptor);
  await expect(readArchive(path)).rejects.toThrow();
});

test("accepts a data descriptor with a signature", async () => {
  const path = await archivePath();
  const original = fixture();
  const dataEnd = 43;
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(0x3610a686, 4); descriptor.writeUInt32LE(5, 8); descriptor.writeUInt32LE(5, 12);
  const archive = Buffer.concat([original.subarray(0, dataEnd), descriptor, original.subarray(dataEnd)]);
  archive.writeUInt16LE(8, 6); archive.writeUInt16LE(8, dataEnd + 16 + 8);
  archive.writeUInt32LE(dataEnd + 16, archive.length - 6);
  await writeFile(path, archive);
  const [entry] = await readArchive(path);
  expect(await new Response(entryBody(path, entry!)).text()).toBe("hello");
});

test("rejects encryption, unsupported methods, directory overlap and duplicate names", async () => {
  const path = await archivePath();
  for (const mutate of [
    (data: Buffer) => data.writeUInt16LE(1, 43 + 8),
    (data: Buffer) => data.writeUInt16LE(12, 43 + 10),
    (data: Buffer) => data.writeUInt32LE(44, 43 + 42),
  ]) {
    const data = fixture(); mutate(data); await writeFile(path, data);
    await expect(readArchive(path)).rejects.toThrow();
  }
  const original = fixture();
  const directory = original.subarray(43, 97);
  const end = Buffer.from(original.subarray(97));
  end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(108, 12);
  await writeFile(path, Buffer.concat([original.subarray(0, 43), directory, directory, end]));
  await expect(readArchive(path)).rejects.toThrow();
});

test("reads ZIP64 entry offsets beyond four GiB without reading the gap", async () => {
  const path = await archivePath();
  const offset = 0x100000000;
  const base = fixture();
  const centralOffset = 43;
  const local = base.subarray(0, centralOffset);
  const central = Buffer.from(base.subarray(centralOffset, centralOffset + 54));
  central.writeUInt32LE(0xffffffff, 42);
  central.writeUInt16LE(12, 30);
  const extra = Buffer.alloc(12); extra.writeUInt16LE(1, 0); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(BigInt(offset), 4);
  const directoryOffset = offset + local.length;
  const zipEnd = Buffer.alloc(56); zipEnd.writeUInt32LE(0x06064b50, 0); zipEnd.writeBigUInt64LE(44n, 4); zipEnd.writeUInt16LE(45, 12); zipEnd.writeUInt16LE(45, 14);
  zipEnd.writeBigUInt64LE(1n, 24); zipEnd.writeBigUInt64LE(1n, 32); zipEnd.writeBigUInt64LE(66n, 40); zipEnd.writeBigUInt64LE(BigInt(directoryOffset), 48);
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(directoryOffset + 66), 8); locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
  const file = await open(path, "w");
  try {
    await file.write(local, 0, local.length, offset);
    const rest = Buffer.concat([central, extra, zipEnd, locator, end]);
    await file.write(rest, 0, rest.length, directoryOffset);
  } finally { await file.close(); }
  const [entry] = await readArchive(path);
  expect(entry!.offset).toBe(offset + 38);
  expect(await new Response(entryBody(path, entry!)).text()).toBe("hello");
});
