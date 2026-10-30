import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

export interface ArchiveEntry {
  name: string;
  offset: number;
  size: number;
  compressedSize: number;
  method: 0 | 8;
  crc32: number;
}

const MAX_ENTRIES = 100_000;
const MAX_DIRECTORY = 64 * 1024 * 1024;
const MAX_NAME = 4096;
const decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(): never { throw new Error("Invalid ZIP archive"); }
function number64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return Number(value);
}
function sum(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function zip64(extra: Buffer, needs: boolean[]): number[] {
  let position = 0;
  while (position + 4 <= extra.length) {
    const id = extra.readUInt16LE(position);
    const length = extra.readUInt16LE(position + 2);
    position += 4;
    if (position + length > extra.length) invalid();
    if (id === 1) {
      const values: number[] = [];
      let cursor = position;
      for (const needed of needs) {
        if (needed) {
          if (cursor + 8 > position + length) invalid();
          values.push(number64(extra, cursor));
          cursor += 8;
        } else values.push(0);
      }
      return values;
    }
    position += length;
  }
  if (position !== extra.length || needs.some(Boolean)) invalid();
  return needs.map(() => 0);
}

function validName(bytes: Buffer, flags: number): string {
  if (bytes.length === 0 || bytes.length > MAX_NAME || (!(flags & 0x800) && bytes.some((byte) => byte >= 128))) invalid();
  let name: string;
  try { name = decoder.decode(bytes); } catch { return invalid(); }
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) invalid();
  const parts = name.split("/");
  if (parts.some((part, index) => part === "." || part === ".." || (part === "" && index !== parts.length - 1))) invalid();
  return name;
}

function bodyStream(path: string, entry: ArchiveEntry): { stream: ReadableStream<Uint8Array>; inflate?: ReturnType<typeof createInflateRaw> } {
  if (entry.compressedSize === 0 && entry.method === 0) return { stream: new ReadableStream({ start(controller) { controller.close(); } }) };
  if (entry.compressedSize === 0) invalid();
  const source = createReadStream(path, { start: entry.offset, end: entry.offset + entry.compressedSize - 1 });
  if (entry.method === 8) {
    const inflate = createInflateRaw();
    source.on("error", (error) => inflate.destroy(error));
    inflate.on("close", () => source.destroy());
    return { stream: Readable.toWeb(source.pipe(inflate)) as unknown as ReadableStream<Uint8Array>, inflate };
  }
  return { stream: Readable.toWeb(source) as unknown as ReadableStream<Uint8Array> };
}

export function entryBody(path: string, entry: ArchiveEntry): ReadableStream<Uint8Array> {
  return bodyStream(path, entry).stream;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

async function validateBody(path: string, entry: ArchiveEntry, signal?: AbortSignal): Promise<void> {
  let crc = 0xffffffff;
  let size = 0;
  const body = bodyStream(path, entry);
  for await (const chunk of body.stream) {
    signal?.throwIfAborted();
    size = sum(size, chunk.length);
    if (size > entry.size) invalid();
    for (const byte of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  }
  if (size !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32 || (body.inflate && body.inflate.bytesWritten !== entry.compressedSize)) invalid();
}

export async function readArchive(path: string, signal?: AbortSignal): Promise<ArchiveEntry[]> {
  const file = await open(path, "r");
  try {
    const length = (await file.stat()).size;
    if (!Number.isSafeInteger(length) || length < 22) invalid();
    async function read(offset: number, size: number): Promise<Buffer> {
      if (!Number.isSafeInteger(offset) || offset < 0 || sum(offset, size) > length) invalid();
      const buffer = Buffer.alloc(size);
      let done = 0;
      while (done < size) {
        const result = await file.read(buffer, done, size - done, offset + done);
        if (!result.bytesRead) invalid();
        done += result.bytesRead;
      }
      return buffer;
    }
    const tailSize = Math.min(length, 65557);
    const tail = await read(length - tailSize, tailSize);
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { end = index; break; }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) invalid();
    let count = tail.readUInt16LE(end + 10);
    if (tail.readUInt16LE(end + 8) !== count) invalid();
    let directorySize = tail.readUInt32LE(end + 12);
    let directoryOffset = tail.readUInt32LE(end + 16);
    let boundary = length - tailSize + end;
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      if (boundary < 20) invalid();
      const locator = await read(boundary - 20, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) invalid();
      const zipEndOffset = number64(locator, 8);
      const zipEnd = await read(zipEndOffset, 56);
      if (zipEnd.readUInt32LE(0) !== 0x06064b50 || number64(zipEnd, 4) < 44 || sum(zipEndOffset, sum(12, number64(zipEnd, 4))) !== boundary - 20 || zipEnd.readUInt32LE(16) || zipEnd.readUInt32LE(20)) invalid();
      count = number64(zipEnd, 32);
      if (number64(zipEnd, 24) !== count) invalid();
      directorySize = number64(zipEnd, 40);
      directoryOffset = number64(zipEnd, 48);
      boundary = zipEndOffset;
    }
    if (count > MAX_ENTRIES || directorySize > MAX_DIRECTORY || sum(directoryOffset, directorySize) !== boundary) invalid();
    let cursor = directoryOffset;
    const entries: ArchiveEntry[] = [];
    const names = new Set<string>();
    const ranges: [number, number][] = [];
    for (let index = 0; index < count; index++) {
      if (sum(cursor, 46) > boundary) invalid();
      const header = await read(cursor, 46);
      if (header.readUInt32LE(0) !== 0x02014b50) invalid();
      const flags = header.readUInt16LE(8);
      const method = header.readUInt16LE(10);
      if ((flags & ~0x080e) || (method !== 0 && method !== 8) || (method === 0 && (flags & 6))) invalid();
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const next = sum(cursor, 46 + nameLength + extraLength + commentLength);
      if (next > boundary || nameLength > MAX_NAME || header.readUInt16LE(34) !== 0) invalid();
      const variable = await read(cursor + 46, nameLength + extraLength);
      const nameBytes = variable.subarray(0, nameLength);
      const name = validName(nameBytes, flags);
      if (names.has(name)) invalid();
      names.add(name);
      let size = header.readUInt32LE(24);
      let compressedSize = header.readUInt32LE(20);
      let localOffset = header.readUInt32LE(42);
      const values = zip64(variable.subarray(nameLength), [size === 0xffffffff, compressedSize === 0xffffffff, localOffset === 0xffffffff]);
      if (size === 0xffffffff) size = values[0]!;
      if (compressedSize === 0xffffffff) compressedSize = values[1]!;
      if (localOffset === 0xffffffff) localOffset = values[2]!;
      if (method === 0 && size !== compressedSize) invalid();
      if (sum(localOffset, 30) > directoryOffset) invalid();
      const local = await read(localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) invalid();
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const offset = sum(localOffset, 30 + localNameLength + localExtraLength);
      const dataEnd = sum(offset, compressedSize);
      if (dataEnd > directoryOffset || localNameLength !== nameLength) invalid();
      const localVariable = await read(localOffset + 30, localNameLength + localExtraLength);
      if (!localVariable.subarray(0, localNameLength).equals(nameBytes)) invalid();
      if (!(flags & 8)) {
        let localSize = local.readUInt32LE(22);
        let localCompressed = local.readUInt32LE(18);
        const localValues = zip64(localVariable.subarray(localNameLength), [localSize === 0xffffffff, localCompressed === 0xffffffff]);
        if (localSize === 0xffffffff) localSize = localValues[0]!;
        if (localCompressed === 0xffffffff) localCompressed = localValues[1]!;
        if (localSize !== size || localCompressed !== compressedSize || local.readUInt32LE(14) !== header.readUInt32LE(16)) invalid();
      }
      const entry: ArchiveEntry = { name, offset, size, compressedSize, method, crc32: header.readUInt32LE(16) };
      entries.push(entry);
      let rangeEnd = dataEnd;
      if (flags & 8) {
        const available = Math.min(24, directoryOffset - dataEnd);
        if (available < 12) invalid();
        const descriptor = await read(dataEnd, available);
        const candidates: number[] = [];
        for (const prefix of [0, 4]) {
          if (prefix && descriptor.readUInt32LE(0) !== 0x08074b50) continue;
          if (available >= prefix + 12 && descriptor.readUInt32LE(prefix) === entry.crc32 && descriptor.readUInt32LE(prefix + 4) === compressedSize && descriptor.readUInt32LE(prefix + 8) === size) candidates.push(prefix + 12);
          if (available >= prefix + 20 && descriptor.readUInt32LE(prefix) === entry.crc32 && descriptor.readBigUInt64LE(prefix + 4) === BigInt(compressedSize) && descriptor.readBigUInt64LE(prefix + 12) === BigInt(size)) candidates.push(prefix + 20);
        }
        if (!candidates.length) invalid();
        rangeEnd = sum(dataEnd, Math.max(...candidates));
      }
      ranges.push([localOffset, rangeEnd]);
      cursor = next;
    }
    if (cursor !== boundary) invalid();
    ranges.sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < ranges.length; index++) if (ranges[index]![0] < ranges[index - 1]![1]) invalid();
    for (const entry of entries) { signal?.throwIfAborted(); await validateBody(path, entry, signal); }
    return entries;
  } finally { await file.close(); }
}
