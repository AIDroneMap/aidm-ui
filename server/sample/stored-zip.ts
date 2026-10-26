// Reads where the files of a stored zip sit, so they can be streamed straight
// out of the archive. Only the pieces needed are read, never the whole file.

export interface ZipEntry {
  name: string;
  /** First byte of the entry's data in the file. */
  offset: number;
  size: number;
}

export class ZipFormatError extends Error {}

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_RECORD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const NO_ZIP64 = 0xffffffff;

async function readRange(file: Blob, start: number, end: number): Promise<DataView> {
  if (start < 0 || end > file.size || start > end) {
    throw new ZipFormatError("The zip is cut short or damaged.");
  }
  const bytes = await file.slice(start, end).arrayBuffer();
  if (bytes.byteLength !== end - start) throw new ZipFormatError("The zip is cut short.");
  return new DataView(bytes);
}

export async function readStoredZip(path: string): Promise<ZipEntry[]> {
  const file = Bun.file(path);
  const total = file.size;
  if (total < END_RECORD_SIZE) throw new ZipFormatError("The file is too small to be a zip.");

  const tailStart = Math.max(0, total - (MAX_COMMENT + END_RECORD_SIZE));
  const tail = await readRange(file, tailStart, total);
  let end = -1;
  for (let at = tail.byteLength - END_RECORD_SIZE; at >= 0; at--) {
    if (tail.getUint32(at, true) === END_SIGNATURE) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ZipFormatError("The end of the zip was not found.");

  const count = tail.getUint16(end + 10, true);
  const directorySize = tail.getUint32(end + 12, true);
  const directoryOffset = tail.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === NO_ZIP64 || directoryOffset === NO_ZIP64) {
    throw new ZipFormatError("Zip64 archives are not supported.");
  }

  const directory = await readRange(file, directoryOffset, directoryOffset + directorySize);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > directory.byteLength || directory.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError("The zip's file list is damaged.");
    }
    const flags = directory.getUint16(at + 8, true);
    const method = directory.getUint16(at + 10, true);
    const compressed = directory.getUint32(at + 20, true);
    const size = directory.getUint32(at + 24, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    const localOffset = directory.getUint32(at + 42, true);
    if (at + 46 + nameLength > directory.byteLength) {
      throw new ZipFormatError("The zip's file list is damaged.");
    }
    const name = decoder.decode(new Uint8Array(directory.buffer, at + 46, nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;
    if ((flags & 1) !== 0) throw new ZipFormatError(`${name} is encrypted.`);
    if (method !== 0) throw new ZipFormatError(`${name} is compressed, not stored.`);
    if (compressed === NO_ZIP64 || size === NO_ZIP64 || localOffset === NO_ZIP64) {
      throw new ZipFormatError("Zip64 archives are not supported.");
    }
    if (compressed !== size) throw new ZipFormatError(`${name} has inconsistent sizes.`);

    const local = await readRange(file, localOffset, localOffset + 30);
    if (local.getUint32(0, true) !== LOCAL_SIGNATURE) {
      throw new ZipFormatError("A file header in the zip is damaged.");
    }
    const offset = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    if (offset + size > total) throw new ZipFormatError("The zip is cut short.");
    entries.push({ name, offset, size });
  }
  return entries;
}
