import { xmpBand } from "./xmp.ts";
import { open } from 'node:fs/promises';

export interface PhotoMetadata {
  captureTime: string | null;
  make: string | null;
  model: string | null;
  width: number | null;
  height: number | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  band: string | null;
}

function bandFromBytes(data: Buffer, trailingNulls = false): string | null {
  let end = data.length;
  if (trailingNulls) while (end > 0 && data[end - 1] === 0) end--;
  return xmpBand(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, end)));
}

export async function readPhotoMetadata(path: string, originalName: string): Promise<PhotoMetadata> {
  const facts: PhotoMetadata = { captureTime: null, make: null, model: null, width: null, height: null, latitude: null, longitude: null, altitude: null, band: null };
  try {
    if (/\.(?:raw|bmp)$/i.test(originalName)) return facts;
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      const size = info.size;
      if (!info.isFile() || !Number.isSafeInteger(size)) return facts;
      let totalRead = 0;
      const read = async (offset: number, length: number): Promise<Buffer> => {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size || length > 1048576) throw new Error('Invalid metadata');
        totalRead += length;
        if (totalRead > 4 * 1024 * 1024) throw new Error('Metadata read limit exceeded');
        const buffer = Buffer.alloc(length);
        let received = 0;
        while (received < length) {
          const { bytesRead } = await file.read(buffer, received, length - received, offset + received);
          if (bytesRead === 0) throw new Error('Truncated metadata');
          received += bytesRead;
        }
        return buffer;
      };
      let base = 0;
      let tiffEnd = size;
      let containerDimensions: [number, number] | null = null;
      let band: string | null = null;
      const signature = await read(0, 2);
      if (signature.equals(Buffer.from([137, 80]))) {
        if (!(await read(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG');
        let position = 8, chunks = 0, ended = false;
        while (position + 12 <= size && chunks++ < 10000) {
          const chunk = await read(position, 8);
          const length = chunk.readUInt32BE(0), name = chunk.toString('ascii', 4, 8);
          if (position + 12 + length > size) throw new Error('Invalid chunk');
          if (name === 'IHDR') {
            if (position !== 8 || length !== 13) throw new Error('Invalid header');
            const dimensions = await read(position + 8, 8);
            const width = dimensions.readUInt32BE(0), height = dimensions.readUInt32BE(4);
            if (!width || !height) throw new Error('Invalid dimensions');
            containerDimensions = [width, height];
          }
          if (name === 'eXIf') { base = position + 8; tiffEnd = base + length; }
          if (name === 'iTXt' && length <= 1048576) {
            const data = await read(position + 8, length);
            const keywordEnd = data.indexOf(0);
            if (keywordEnd >= 0 && data.toString('ascii', 0, keywordEnd) === 'XML:com.adobe.xmp') {
              const compression = data[keywordEnd + 1], method = data[keywordEnd + 2];
              const languageEnd = data.indexOf(0, keywordEnd + 3);
              const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
              if ((compression !== 0 && compression !== 1) || method !== 0 || languageEnd < 0 || translatedEnd < 0) throw new Error('Invalid PNG text');
              if (compression === 0) band = bandFromBytes(data.subarray(translatedEnd + 1));
            }
          }
          position += length + 12;
          if (name === 'IEND') { ended = true; break; }
        }
        if (!ended || !containerDimensions) throw new Error('Invalid PNG');
        if (!base) { [facts.width, facts.height] = containerDimensions; facts.band = band; return facts; }
      } else if (signature.equals(Buffer.from([0, 0]))) {
        if (!(await read(0, 12)).equals(Buffer.from([0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20, 13, 10, 0x87, 10]))) return facts;
        let position = 12, boxes = 0;
        while (position < size && boxes++ < 10000) {
          const box = await read(position, 8);
          let length = box.readUInt32BE(0), headerLength = 8;
          if (length === 1) {
            const extended = (await read(position + 8, 8)).readBigUInt64BE();
            if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid box');
            length = Number(extended); headerLength = 16;
          } else if (length === 0) length = size - position;
          if (length < headerLength || position + length > size) throw new Error('Invalid box');
          if (box.toString('ascii', 4, 8) === 'Exif') {
            const start = position + headerLength;
            if (length < headerLength + 4) throw new Error('Invalid Exif box');
            base = start + 4 + (await read(start, 4)).readUInt32BE();
            tiffEnd = position + length;
            if (base + 8 > tiffEnd) throw new Error('Invalid Exif offset');
          }
          if (box.toString('ascii', 4, 8) === 'xml ' && length - headerLength <= 1048576) band = bandFromBytes(await read(position + headerLength, length - headerLength));
          position += length;
        }
        if (position !== size) throw new Error('Invalid boxes');
        if (!base) { facts.band = band; return facts; }
      } else if (signature.equals(Buffer.from([0xff, 0xd8]))) {
        let position = 2, segments = 0, ended = false;
        while (position + 2 <= size && segments++ < 10000) {
          const markerBytes = await read(position, 2);
          if (markerBytes[0] !== 0xff) throw new Error('Invalid marker');
          if (markerBytes[1] === 0xda || markerBytes[1] === 0xd9) { ended = true; break; }
          const marker = await read(position, 4);
          const length = marker.readUInt16BE(2);
          if (length < 2 || position + 2 + length > size) throw new Error('Invalid segment');
          const code = marker[1]!;
          if (code >= 0xc0 && code <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(code)) {
            if (length < 8) throw new Error('Invalid JPEG frame');
            const frame = await read(position + 4, 6);
            const height = frame.readUInt16BE(1), width = frame.readUInt16BE(3), components = frame[5]!;
            if (!width || !height || !components || length !== 8 + components * 3) throw new Error('Invalid JPEG frame');
            containerDimensions = [width, height];
          }
          if (marker[1] === 0xe1 && length >= 8 && (await read(position + 4, 6)).equals(Buffer.from('Exif\0\0'))) {
            base = position + 10;
            tiffEnd = position + 2 + length;
          }
          const prefix = Buffer.from('http://ns.adobe.com/xap/1.0/\0');
          if (marker[1] === 0xe1 && length >= prefix.length + 2 && (await read(position + 4, prefix.length)).equals(prefix)) band = bandFromBytes(await read(position + 4 + prefix.length, length - 2 - prefix.length));
          position += length + 2;
        }
        if (!ended) throw new Error('Invalid JPEG');
        if (!base) { if (containerDimensions) [facts.width, facts.height] = containerDimensions; facts.band = band; return facts; }
      }
      const readTiff = (offset: number, length: number) => {
        if (offset < base || offset + length > tiffEnd) throw new Error('Invalid TIFF offset');
        return read(offset, length);
      };
      const header = await readTiff(base, 8);
      const little = header.toString('ascii', 0, 2) === 'II';
      if (!little && header.toString('ascii', 0, 2) !== 'MM') return facts;
      const u16 = (buffer: Buffer, offset: number) => little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
      const u32 = (buffer: Buffer, offset: number) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
      if (u16(header, 2) !== 42) return facts;
      const seen = new Set<number>();
      let date: string | null = null, fraction: string | null = null, zone: string | null = null;
      const gps = new Map<number, string | number | number[]>();
      const visit = async (relative: number, kind: 'main' | 'exif' | 'gps', primary = true) => {
        if (!relative || seen.has(relative) || seen.size >= 16) throw new Error('Invalid IFD');
        seen.add(relative);
        const offset = base + relative;
        const count = u16(await readTiff(offset, 2), 0);
        if (count > 512) throw new Error('Too many entries');
        const entries = await readTiff(offset + 2, count * 12 + 4);
        for (let index = 0; index < count; index++) {
          if (!primary) continue;
          const position = index * 12;
          const tag = u16(entries, position), type = u16(entries, position + 2), count = u32(entries, position + 4);
          const relevant = kind === 'main' ? [256, 257, 271, 272, 700, 34665, 34853].includes(tag) : kind === 'exif' ? [36867, 36881, 37521, 40962, 40963].includes(tag) : [1, 2, 3, 4, 5, 6].includes(tag);
          if (!relevant) continue;
          const dimension = kind === 'main' ? tag === 256 || tag === 257 : kind === 'exif' && (tag === 40962 || tag === 40963);
          if (dimension && (count !== 1 || (type !== 3 && type !== 4))) throw new Error('Invalid dimension tag');
          const unit = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 } as Record<number, number>)[type];
          if (!unit || !count || count * unit > (tag === 700 ? 256 * 1024 : 4096)) throw new Error('Invalid value');
          const length = count * unit;
          const data = length <= 4 ? entries.subarray(position + 8, position + 8 + length) : await readTiff(base + u32(entries, position + 8), length);
          const text = type === 2 ? data.toString('utf8').replace(/\0.*$/, '') : '';
          const number = type === 1 ? data.readUInt8(0) : type === 3 ? u16(data, 0) : type === 4 ? u32(data, 0) : null;
          if (kind === 'main' && (tag === 34665 || tag === 34853)) {
            if (type !== 4 || count !== 1 || number === null) throw new Error('Invalid IFD pointer');
            await visit(number, tag === 34665 ? 'exif' : 'gps');
          } else if (kind === 'main' || kind === 'exif') {
            if (tag === 700 && (type === 1 || type === 2)) band = bandFromBytes(data, true);
            if (tag === 271 && text) facts.make = text;
            if (tag === 272 && text) facts.model = text;
            if ((tag === 256 || tag === 40962) && number !== null && number > 0) facts.width = number;
            if ((tag === 257 || tag === 40963) && number !== null && number > 0) facts.height = number;
            if (tag === 36867) date = text;
            if (tag === 36881) zone = text;
            if (tag === 37521) fraction = text;
          } else if (type === 2) gps.set(tag, text);
          else if (type === 5) {
            const values: number[] = [];
            for (let part = 0; part < count; part++) {
              const denominator = u32(data, part * 8 + 4);
              if (!denominator) throw new Error('Invalid rational');
              values.push(u32(data, part * 8) / denominator);
            }
            gps.set(tag, values);
          } else if (number !== null) gps.set(tag, number);
        }
        const next = u32(entries, count * 12);
        if (next) await visit(next, kind, false);
      };
      await visit(u32(header, 4), 'main');
      if (date) {
        const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(date);
        if (match) {
          const [, year = '', month = '', day = '', hour = '', minute = '', second = ''] = match;
          const check = new Date(`${year}-${month}-${day}T00:00:00Z`);
          if (!Number.isNaN(check.getTime()) && check.toISOString().slice(0, 10) === `${year}-${month}-${day}` && +hour < 24 && +minute < 60 && +second < 60) {
            facts.captureTime = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction && /^\d+$/.test(fraction) ? `.${fraction}` : ''}${zone && /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(zone) ? zone : ''}`;
          }
        }
      }
      const coordinate = (reference: unknown, values: unknown, positive: string, negative: string, limit: number): number | null => {
        if ((reference !== positive && reference !== negative) || !Array.isArray(values) || values.length !== 3 || values[1] >= 60 || values[2] >= 60) return null;
        const result = values[0] + values[1] / 60 + values[2] / 3600;
        return result <= limit ? result * (reference === negative ? -1 : 1) : null;
      };
      facts.latitude = coordinate(gps.get(1), gps.get(2), 'N', 'S', 90);
      facts.longitude = coordinate(gps.get(3), gps.get(4), 'E', 'W', 180);
      const altitude = gps.get(6), altitudeRef = gps.get(5);
      if (Array.isArray(altitude) && altitude.length === 1 && (altitudeRef === 0 || altitudeRef === 1)) facts.altitude = altitude[0]! * (altitudeRef === 1 ? -1 : 1);
      if (containerDimensions) [facts.width, facts.height] = containerDimensions;
      facts.band = band;
      return facts;
    } finally { await file.close(); }
  } catch {
    return { captureTime: null, make: null, model: null, width: null, height: null, latitude: null, longitude: null, altitude: null, band: null };
  }
}
