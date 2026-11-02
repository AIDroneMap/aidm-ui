import type { FileHandle } from "node:fs/promises";

/** The largest preview served. Real ones are a few tens of kilobytes. */
export const MAX_THUMBNAIL_BYTES = 512 * 1024;
/** Everything one photo may make the server read for its preview, structure and bytes together. */
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_IFD_ENTRIES = 512;
const MAX_SEGMENTS = 1000;
const EXIF_PREFIX = Buffer.from("Exif\0\0");

/** A file the preview is cut out of. Positions and lengths are checked before every read. */
export interface PhotoBytes {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

/** The bounded reader the stores hand to the extractor: it reads from an open file and nothing else. */
export function photoBytes(file: FileHandle, size: number): PhotoBytes {
  return {
    size,
    async read(offset, length) {
      const buffer = Buffer.alloc(length);
      let received = 0;
      while (received < length) {
        const { bytesRead } = await file.read(buffer, received, length - received, offset + received);
        if (bytesRead === 0) throw new Malformed();
        received += bytesRead;
      }
      return buffer;
    },
  };
}

class Malformed extends Error {}

/**
 * The JPEG that the camera embedded in the photo (the second image directory of
 * its Exif data), or null when there is none or the file is not well formed.
 * The bytes are never decoded or resized.
 */
export async function embeddedThumbnail(file: PhotoBytes): Promise<Buffer | null> {
  let total = 0;
  const read = async (offset: number, length: number): Promise<Buffer> => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > file.size) throw new Malformed();
    total += length;
    if (total > MAX_READ_BYTES) throw new Malformed();
    return length === 0 ? Buffer.alloc(0) : file.read(offset, length);
  };
  try {
    const signature = file.size >= 2 ? await read(0, 2) : Buffer.alloc(2);
    if (signature[0] === 0xff && signature[1] === 0xd8) {
      const exif = await exifSegment(read, file.size);
      return exif === null ? null : await thumbnailFromTiff(read, exif.base, exif.end);
    }
    return await thumbnailFromTiff(read, 0, file.size);
  } catch (error) {
    if (error instanceof Malformed) return null;
    throw error;
  }
}

type Read = (offset: number, length: number) => Promise<Buffer>;

/** Where the TIFF data of the first Exif segment of a JPEG starts and ends. Image data is never reached. */
async function exifSegment(read: Read, size: number): Promise<{ base: number; end: number } | null> {
  let position = 2;
  for (let segments = 0; segments < MAX_SEGMENTS && position + 4 <= size; segments++) {
    const marker = await read(position, 4);
    // The image data starts at the scan, and an end marker means there was no Exif.
    if (marker[0] !== 0xff || marker[1] === 0xda || marker[1] === 0xd9) return null;
    const length = marker.readUInt16BE(2);
    if (length < 2 || position + 2 + length > size) throw new Malformed();
    if (marker[1] === 0xe1 && length >= 8 && (await read(position + 4, 6)).equals(EXIF_PREFIX)) return { base: position + 10, end: position + 2 + length };
    position += 2 + length;
  }
  return null;
}

/** `base` is where the TIFF header starts, `end` the first byte after the Exif data. */
async function thumbnailFromTiff(read: Read, base: number, end: number): Promise<Buffer | null> {
  const inside = (offset: number, length: number) => {
    if (offset < base || length < 0 || offset + length > end) throw new Malformed();
    return read(offset, length);
  };
  const header = await inside(base, 8);
  const order = header.toString("ascii", 0, 2);
  if (order !== "II" && order !== "MM") return null;
  const little = order === "II";
  const u16 = (buffer: Buffer, at: number) => little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at);
  const u32 = (buffer: Buffer, at: number) => little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);
  if (u16(header, 2) !== 42) return null;
  const first = u32(header, 4);
  const directory = async (relative: number) => {
    const count = u16(await inside(base + relative, 2), 0);
    if (count > MAX_IFD_ENTRIES) throw new Malformed();
    return { entries: await inside(base + relative + 2, count * 12 + 4), count };
  };
  const main = await directory(first);
  const second = u32(main.entries, main.count * 12);
  if (second === 0 || second === first) return null;
  const thumbnailDirectory = await directory(second);
  const values = new Map<number, number>();
  for (let index = 0; index < thumbnailDirectory.count; index++) {
    const at = index * 12;
    const tag = u16(thumbnailDirectory.entries, at), type = u16(thumbnailDirectory.entries, at + 2), count = u32(thumbnailDirectory.entries, at + 4);
    if (tag !== 0x0103 && tag !== 0x0201 && tag !== 0x0202) continue;
    if (count !== 1 || (type !== 3 && type !== 4)) throw new Malformed();
    values.set(tag, type === 3 ? u16(thumbnailDirectory.entries, at + 8) : u32(thumbnailDirectory.entries, at + 8));
  }
  const offset = values.get(0x0201), length = values.get(0x0202), compression = values.get(0x0103);
  if (offset === undefined || length === undefined || (compression !== undefined && compression !== 6)) return null;
  if (length < 4 || length > MAX_THUMBNAIL_BYTES) return null;
  const bytes = await inside(base + offset, length);
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
}
