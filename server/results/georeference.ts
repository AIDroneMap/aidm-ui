import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInflateRaw } from "node:zlib";
import type { ArchiveEntry } from "./zip.ts";

const LIMIT = 1024 * 1024;
const MAX_TAGS = 256;

function utmToWgs84(easting: number, northing: number, epsg: number): [number, number] {
  const south = epsg >= 32701;
  const zone = epsg - (south ? 32700 : 32600);
  if (zone < 1 || zone > 60 || easting < 100000 || easting > 900000 || northing < 0 || northing > 10000000) throw Error();
  const eccentricity = 0.0066943799901413165;
  const second = eccentricity / (1 - eccentricity);
  const meridian = (northing - (south ? 10000000 : 0)) / 0.9996;
  const mu = meridian / (6378137 * (1 - eccentricity / 4 - 3 * eccentricity ** 2 / 64 - 5 * eccentricity ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - eccentricity)) / (1 + Math.sqrt(1 - eccentricity));
  const foot = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + 151 * e1 ** 3 / 96 * Math.sin(6 * mu) + 1097 * e1 ** 4 / 512 * Math.sin(8 * mu);
  const sin = Math.sin(foot); const cos = Math.cos(foot); const tangent = Math.tan(foot);
  const curvature = 6378137 / Math.sqrt(1 - eccentricity * sin ** 2);
  const radius = 6378137 * (1 - eccentricity) / (1 - eccentricity * sin ** 2) ** 1.5;
  const t = tangent ** 2; const c = second * cos ** 2; const d = (easting - 500000) / (curvature * 0.9996);
  const lat = foot - curvature * tangent / radius * (d ** 2 / 2 - (5 + 3 * t + 10 * c - 4 * c ** 2 - 9 * second) * d ** 4 / 24 + (61 + 90 * t + 298 * c + 45 * t ** 2 - 252 * second - 3 * c ** 2) * d ** 6 / 720);
  const lon = (zone * 6 - 183) * Math.PI / 180 + (d - (1 + 2 * t + c) * d ** 3 / 6 + (5 - 2 * c + 28 * t - 3 * c ** 2 + 8 * second + 24 * t ** 2) * d ** 5 / 120) / cos;
  const result: [number, number] = [lon * 180 / Math.PI, lat * 180 / Math.PI];
  if (result[1] < -80 || result[1] > 84 || Math.abs(result[0] - (zone * 6 - 183)) > 6) throw Error();
  return result;
}

export async function readGeoreference(path: string, entry: ArchiveEntry): Promise<{ bounds: [number, number, number, number]; epsg: number } | null> {
  let close: (() => Promise<void>) | undefined;
  try {
    if (![entry.offset, entry.size, entry.compressedSize].every((value) => Number.isSafeInteger(value) && value >= 0) || !Number.isSafeInteger(entry.offset + entry.compressedSize)) return null;
    if (entry.method !== 0 && entry.method !== 8) return null;
    if (entry.method === 0 && entry.size !== entry.compressedSize) return null;
    let read: (offset: number, length: number) => Promise<Buffer>;
    let total = 0;
    if (entry.method === 0) {
      const file = await open(path, "r");
      close = async () => { await file.close(); };
      read = async (offset, length) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset + length > entry.size || (total += length) > LIMIT) throw Error();
        const buffer = Buffer.alloc(length);
        let done = 0;
        while (done < length) {
          const result = await file.read(buffer, done, length - done, entry.offset + offset + done);
          if (!result.bytesRead) throw Error();
          done += result.bytesRead;
        }
        return buffer;
      };
    } else {
      if (!entry.compressedSize) return null;
      const source = createReadStream(path, { start: entry.offset, end: entry.offset + Math.min(entry.compressedSize, LIMIT) - 1 });
      const inflate = createInflateRaw();
      source.on("error", (error) => inflate.destroy(error));
      source.pipe(inflate);
      const reader = inflate[Symbol.asyncIterator]();
      close = async () => { source.destroy(); inflate.destroy(); };
      const prefix = Buffer.alloc(Math.min(entry.size, LIMIT));
      let available = 0;
      read = async (offset, length) => {
        const end = offset + length;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(end) || end > entry.size || end > LIMIT || (total += length) > LIMIT) throw Error();
        while (available < end) {
          const result = await reader.next();
          if (result.done || result.value.length === 0) throw Error();
          const take = Math.min(result.value.length, LIMIT - available);
          prefix.set(result.value.subarray(0, take), available);
          available += take;
        }
        return prefix.subarray(offset, end);
      };
    }
    const header = await read(0, 8);
    const little = header.toString("ascii", 0, 2) === "II";
    if (!little && header.toString("ascii", 0, 2) !== "MM") return null;
    const u16 = (buffer: Buffer, offset: number) => little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    const u32 = (buffer: Buffer, offset: number) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const u64 = (buffer: Buffer, offset: number) => {
      const value = little ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error();
      return Number(value);
    };
    const version = u16(header, 2);
    const big = version === 43;
    if (version !== 42 && !big) return null;
    const extended = big ? await read(0, 16) : header;
    if (big && (u16(extended, 4) !== 8 || u16(extended, 6) !== 0)) return null;
    const ifd = big ? u64(extended, 8) : u32(header, 4);
    if (ifd < (big ? 16 : 8)) return null;
    const countSize = big ? 8 : 2;
    const countBuffer = await read(ifd, countSize);
    const count = big ? u64(countBuffer, 0) : u16(countBuffer, 0);
    if (count === 0 || count > MAX_TAGS) return null;
    const itemSize = big ? 20 : 12;
    const directory = await read(ifd + countSize, count * itemSize + (big ? 8 : 4));
    const nextIfd = big ? u64(directory, count * itemSize) : u32(directory, count * itemSize);
    // Read the primary image only. Cloud-optimized TIFFs also hold overview directories.
    if (nextIfd !== 0 && (nextIfd < (big ? 16 : 8) || nextIfd > entry.size - countSize || nextIfd >= ifd && nextIfd < ifd + countSize + directory.length)) return null;
    const wanted = new Set([256, 257, 33550, 33922, 34264, 34735]);
    const tags = new Map<number, { type: number; count: number; data: Buffer }>();
    for (let index = 0; index < count; index++) {
      const position = index * itemSize;
      const tag = u16(directory, position);
      if (!wanted.has(tag)) continue;
      if (tags.has(tag)) return null;
      const type = u16(directory, position + 2);
      const elements = big ? u64(directory, position + 4) : u32(directory, position + 4);
      const width = type === 3 ? 2 : type === 4 ? 4 : type === 12 ? 8 : type === 16 ? 8 : 0;
      if (!width || !elements || elements > 4096 || elements * width > LIMIT) return null;
      const size = elements * width;
      const valueOffset = position + (big ? 12 : 8);
      const inline = big ? 8 : 4;
      const data = size <= inline ? directory.subarray(valueOffset, valueOffset + size) : await read(big ? u64(directory, valueOffset) : u32(directory, valueOffset), size);
      tags.set(tag, { type, count: elements, data });
    }
    const integers = (tag: number): number[] | null => {
      const item = tags.get(tag);
      if (!item || ![3, 4, 16].includes(item.type)) return null;
      return Array.from({ length: item.count }, (_, index) => item.type === 3 ? u16(item.data, index * 2) : item.type === 4 ? u32(item.data, index * 4) : u64(item.data, index * 8));
    };
    const doubles = (tag: number): number[] | null => {
      const item = tags.get(tag);
      if (!item || item.type !== 12) return null;
      return Array.from({ length: item.count }, (_, index) => little ? item.data.readDoubleLE(index * 8) : item.data.readDoubleBE(index * 8));
    };
    const width = integers(256); const height = integers(257); const keys = integers(34735);
    if (!width || width.length !== 1 || !height || height.length !== 1 || !width[0] || !height[0] || !keys || tags.get(34735)?.type !== 3 || keys.length < 4 || keys[0] !== 1 || keys[1] !== 1 || keys[2] !== 0 || keys.length !== 4 + keys[3]! * 4) return null;
    const geo = new Map<number, number>();
    for (let index = 4; index < keys.length; index += 4) {
      const key = keys[index]!;
      if (geo.has(key)) return null;
      if (keys[index + 1] !== 0 || keys[index + 2] !== 1) {
        if ([1024, 1025, 2048, 2050, 2054, 3072, 3076].includes(key)) return null;
        geo.set(key, -1);
        continue;
      }
      geo.set(key, keys[index + 3]!);
    }
    const rasterType = geo.get(1025) ?? 1;
    const geographic = geo.get(2048); const projected = geo.get(3072); const model = geo.get(1024);
    const utm = projected !== undefined && ((projected >= 32601 && projected <= 32660) || (projected >= 32701 && projected <= 32760));
    if ((rasterType !== 1 && rasterType !== 2) || (geographic !== undefined && geographic !== 4326) || (projected !== undefined && projected !== 3857 && !utm) || (geo.has(2050) && geo.get(2050) !== 6326) || (geo.has(2054) && geo.get(2054) !== 9102) || (geo.has(3076) && geo.get(3076) !== 9001)) return null;
    const epsg = projected ?? geographic;
    if ((epsg !== 4326 && epsg !== 3857 && !utm) || (model !== undefined && model !== (epsg === 4326 ? 2 : 1))) return null;
    const scale = doubles(33550); const tie = doubles(33922); const matrix = doubles(34264);
    if (tags.has(34264) && (tags.has(33550) || tags.has(33922))) return null;
    let transform: (x: number, y: number) => [number, number];
    if (matrix) {
      if (matrix.length !== 16 || !matrix.every(Number.isFinite) || matrix[2] !== 0 || matrix[6] !== 0 || matrix[12] !== 0 || matrix[13] !== 0 || matrix[14] !== 0 || matrix[15] !== 1 || matrix[0]! * matrix[5]! - matrix[1]! * matrix[4]! === 0) return null;
      transform = (x, y) => [matrix[0]! * x + matrix[1]! * y + matrix[3]!, matrix[4]! * x + matrix[5]! * y + matrix[7]!];
    } else {
      if (!scale || scale.length !== 3 || !tie || tie.length !== 6 || ![...scale, ...tie].every(Number.isFinite) || scale[0]! <= 0 || scale[1]! <= 0) return null;
      transform = (x, y) => [tie[3]! + (x - tie[0]!) * scale[0]!, tie[4]! - (y - tie[1]!) * scale[1]!];
    }
    const shift = rasterType === 2 ? -0.5 : 0;
    const corners = [[shift, shift], [width[0]! + shift, shift], [shift, height[0]! + shift], [width[0]! + shift, height[0]! + shift]].map(([x, y]) => transform(x!, y!));
    if (utm) {
      const eastings = corners.map((point) => point[0]);
      const northings = corners.map((point) => point[1]);
      const equator = epsg! >= 32701 ? 10000000 : 0;
      if (corners[0]![0] !== corners[2]![0] || corners[0]![1] !== corners[1]![1] || (Math.min(...eastings) < 500000 && Math.max(...eastings) > 500000) || (Math.min(...northings) < equator && Math.max(...northings) > equator)) return null;
    }
    const points = corners.map(([x, y]) => epsg === 3857 ? [x * 180 / (Math.PI * 6378137), (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI] : utm ? utmToWgs84(x!, y!, epsg!) : [x, y]);
    if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x! < -180 || x! > 180 || y! < -90 || y! > 90)) return null;
    const xs = points.map((point) => point[0]!); const ys = points.map((point) => point[1]!);
    const bounds: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return null;
    return { bounds, epsg: epsg! };
  } catch { return null; }
  finally { await close?.(); }
}
