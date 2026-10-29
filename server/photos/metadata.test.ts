import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPhotoMetadata } from './metadata';
import { detailedTiff, jpeg, jpegXl, jpegXlXmp, jpegXmp, png, pngXmp, tiff } from '../../test-support/photo-metadata';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'photo-facts-'));
  directories.push(directory);
  return directory;
}
async function readBytes(bytes: Uint8Array, name = 'photo.tif') {
  const path = join(await temporaryDirectory(), 'photo');
  await writeFile(path, bytes);
  return readPhotoMetadata(path, name);
}
const noData = { captureTime: null, make: null, model: null, width: null, height: null, latitude: null, longitude: null, altitude: null, band: null };

test('reads camera facts from TIFF', async () => {
  const dir = await temporaryDirectory();
  const path = join(dir, 'photo');
  await writeFile(path, tiff());
  expect(await readPhotoMetadata(path, 'photo.tif')).toEqual({
    captureTime: null, make: 'Acme', model: null, width: 640, height: 480,
    latitude: null, longitude: null, altitude: null, band: null,
  });
});

test('reads JPEG XMP before Exif', async () => {
  const dir = await temporaryDirectory();
  const path = join(dir, 'photo');
  await writeFile(path, jpegXmp('<x xmlns:p="http://pix4d.com/camera/1.0/" p:BandName="Red"/>'));
  const facts = await readPhotoMetadata(path, 'photo.jpg');
  expect([facts.make, facts.band]).toEqual(['Acme', 'Red']);
});

test.each([true, false])('reads Exif and signed GPS in TIFF byte order %s', async (little) => {
  const dir = await temporaryDirectory();
  const path = join(dir, 'photo');
  await writeFile(path, detailedTiff(little));
  expect(await readPhotoMetadata(path, 'photo.dng')).toEqual({
    captureTime: '2024-02-29T12:34:56.123+05:30', make: null, model: 'Model', width: null, height: null,
    latitude: -12.5, longitude: -45.25, altitude: -25, band: null,
  });
});

test('keeps other facts when a capture date is invalid', async () => {
  const dir = await temporaryDirectory();
  const path = join(dir, 'photo');
  const bytes = detailedTiff(true);
  bytes.write('2024:13:29 12:34:56\0', 310);
  await writeFile(path, bytes);
  const facts = await readPhotoMetadata(path, 'photo.nef');
  expect([facts.captureTime, facts.model]).toEqual([null, 'Model']);
});

test('reads Exif from JPEG', async () => {
  const dir = await temporaryDirectory();
  const path = join(dir, 'photo');
  await writeFile(path, jpeg());
  expect((await readPhotoMetadata(path, 'photo.jpg')).make).toBe('Acme');
});

test('reads PNG dimensions and Exif', async () => {
  const dir = await temporaryDirectory();
  const path = join(dir, 'photo');
  await writeFile(path, png());
  expect(await readPhotoMetadata(path, 'photo.png')).toEqual({ captureTime: null, make: 'Acme', model: null, width: 320, height: 240, latitude: null, longitude: null, altitude: null, band: null });
});

test('reads Exif from JPEG XL boxes', async () => {
  const dir = await temporaryDirectory();
  const path = join(dir, 'photo');
  await writeFile(path, jpegXl());
  expect((await readPhotoMetadata(path, 'photo.jxl')).make).toBe('Acme');
});

test.each([
  '<rdf:Description xmlns:rdf="urn:rdf" xmlns:c="http://pix4d.com/camera/1.0/" c:BandName="Green"/>',
  '<rdf:Description xmlns:rdf="urn:rdf" xmlns:camera="http://pix4d.com/camera/1.0/"><camera:BandName>Green</camera:BandName></rdf:Description>',
])('reads namespaced XMP band from JPEG XL', async (xml) => {
  const dir = await temporaryDirectory();
  const path = join(dir, 'photo');
  await writeFile(path, jpegXlXmp(xml));
  expect((await readPhotoMetadata(path, 'photo.jxl')).band).toBe('Green');
});


test('bounds total metadata reads across many XMP packets', async () => {
  const packet = jpegXmp('<x xmlns:c="http://pix4d.com/camera/1.0/" c:BandName="Green">' + ' '.repeat(60000) + '</x>');
  const segmentLength = packet.readUInt16BE(4) + 2;
  const segment = packet.subarray(2, 2 + segmentLength);
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array.from({ length: 80 }, () => segment), jpeg().subarray(2)]);
  expect(await readBytes(bytes, 'photo.jpg')).toEqual(noData);
});

test.each([
  ['<x xmlns:c="http://pix4d.com/camera/1.0/" c:BandName="Green &amp; Red"/>', 'Green & Red'],
  ['<x xmlns="http://pix4d.com/camera/1.0/"><BandName>R&#101;d</BandName></x>', 'Red'],
  ['<x xmlns:c="http://pix4d.com/camera/1.0/"><c:BandName><![CDATA[NIR > red]]></c:BandName></x>', 'NIR > red'],
  ['<x xmlns:c="http://pix4d.com/camera/1.0/" c:BandName="NIR > red"/>', 'NIR > red'],
  ['<x xmlns:c="http://pix4d.com/camera/1.0/" c:BandName="Green"><y xmlns:c="urn:other" c:BandName="Wrong"/></x>', 'Green'],
  ['<x xmlns="http://pix4d.com/camera/1.0/" BandName="Wrong"/>', null],
])('reads XML namespace and character-reference facts', async (xml, band) => {
  expect((await readBytes(jpegXmp(xml!), 'photo.jpg')).band).toBe(band);
});

test.each([
  '<x xmlns:c="http://pix4d.com/camera/1.0/" c:BandName="Green"><y></x>',
  '<x xmlns:c="http://pix4d.com/camera/1.0/" c:BandName="Green" stray/>',
  '<x xmlns:c="http://pix4d.com/camera/1.0/" c:BandName="&unknown;"/>',
  '<!DOCTYPE x [<!ENTITY band SYSTEM "file:///unread">]><x/>',
  '<x c:BandName="Green"/>',
  '<x/><y xmlns:c="http://pix4d.com/camera/1.0/" c:BandName="Green"/>',
])('rejects malformed or unsafe XML without throwing', async xml => {
  expect(await readBytes(jpegXmp(xml), 'photo.jpg')).toEqual(noData);
});


test('reads uncompressed PNG XMP with language and translated keyword fields', async () => {
  const xml = '<x xmlns:c="http://pix4d.com/camera/1.0/" c:BandName="Green"/>';
  expect(await readBytes(pngXmp(xml, 'en', 'Metadata'), 'photo.png')).toMatchObject({ width: 320, height: 240, make: 'Acme', band: 'Green' });
  expect((await readBytes(pngXmp(xml, '', '', true), 'photo.png')).band).toBeNull();
});

test('reads JPEG dimensions from a frame header without Exif', async () => {
  const bytes = Buffer.from('ffd8ffc0000b0801e0028001011100ffd9', 'hex');
  expect(await readBytes(bytes, 'photo.jpg')).toEqual({ ...noData, width: 640, height: 480 });
});

test('preserves an offset-free capture time and rejects invalid calendar dates', async () => {
  const bytes = detailedTiff(true);
  bytes.fill(0, 330, 337);
  expect((await readBytes(bytes, 'photo.nef')).captureTime).toBe('2024-02-29T12:34:56.123');
  bytes.write('2023:02:29 12:34:56\0', 310);
  expect((await readBytes(bytes, 'photo.nef')).captureTime).toBeNull();
});

test('ignores unknown TIFF entries without reading their offsets', async () => {
  const bytes = tiff();
  bytes.writeUInt16LE(65000, 10); bytes.writeUInt16LE(65000, 12); bytes.writeUInt32LE(0xffffffff, 14); bytes.writeUInt32LE(0xffffffff, 18);
  expect(await readBytes(bytes)).toMatchObject({ make: 'Acme', height: 480, width: null });
});

test('returns no data for unreadable, unsupported and malformed metadata', async () => {
  const path = join(await temporaryDirectory(), 'missing');
  expect(await readPhotoMetadata(path, 'missing.jpg')).toEqual(noData);
  for (const name of ['photo.RAW', 'photo.BMP']) expect(await readBytes(detailedTiff(true), name)).toEqual(noData);
  const cyclic = tiff(); cyclic.writeUInt32LE(8, 46);
  const invalidOffset = tiff(); invalidOffset.writeUInt32LE(0xffffff00, 42);
  const tooManyEntries = tiff(); tooManyEntries.writeUInt16LE(65535, 8);
  const tooLongValue = tiff(); tooLongValue.writeUInt32LE(0xffffffff, 38);
  const rational = detailedTiff(true); rational.writeUInt32LE(0, 354);
  const xlOffset = jpegXl(); xlOffset.writeUInt32BE(0xffffff00, 20);
  const xlLength = jpegXl(); xlLength.writeUInt32BE(0xffffffff, 12);
  for (const bytes of [Buffer.alloc(0), Buffer.from('not an image'), tiff().subarray(0, 7), cyclic, invalidOffset, tooManyEntries, tooLongValue, rational, jpeg().subarray(0, -1), png().subarray(0, -1), jpegXl().subarray(0, -1), xlOffset, xlLength]) expect(await readBytes(bytes)).toEqual(noData);
});

test('reads a bounded TIFF XMP packet larger than a text tag', async () => {
  const xml = Buffer.from('<x xmlns:c="http://pix4d.com/camera/1.0/" c:BandName="Red">' + ' '.repeat(6000) + '</x>');
  const bytes = Buffer.alloc(26 + xml.length);
  bytes.write('II'); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4); bytes.writeUInt16LE(1, 8);
  bytes.writeUInt16LE(700, 10); bytes.writeUInt16LE(1, 12); bytes.writeUInt32LE(xml.length, 14); bytes.writeUInt32LE(26, 18); xml.copy(bytes, 26);
  expect((await readBytes(bytes)).band).toBe('Red');
});

test('rejects invalid UTF-8 in an XMP packet', async () => {
  const bytes = jpegXmp('<x xmlns:c="http://pix4d.com/camera/1.0/" c:BandName="Green"/>');
  bytes[bytes.indexOf('Green')] = 0xff;
  expect(await readBytes(bytes, 'photo.jpg')).toEqual(noData);
});

test('rejects invalid scalar TIFF dimensions instead of reporting the first array value', async () => {
  const bytes = tiff(); bytes.writeUInt32LE(2, 14); bytes.writeUInt32LE(50, 18);
  expect(await readBytes(bytes)).toEqual(noData);
});

test('reads extended JPEG XL box lengths and rejects an unsafe length', async () => {
  const normal = jpegXl();
  const header = Buffer.alloc(16); header.writeUInt32BE(1); header.write('Exif', 4); header.writeBigUInt64BE(BigInt(normal.length - 12 + 8), 8);
  const bytes = Buffer.concat([normal.subarray(0, 12), header, normal.subarray(20)]);
  expect((await readBytes(bytes, 'photo.jxl')).make).toBe('Acme');
  bytes.writeBigUInt64BE(0xffffffffffffffffn, 20);
  expect(await readBytes(bytes, 'photo.jxl')).toEqual(noData);
});

test('keeps primary image dimensions when a TIFF thumbnail follows it', async () => {
  const bytes = Buffer.concat([tiff(), Buffer.alloc(64)]);
  bytes.writeUInt32LE(80, 46); bytes.writeUInt16LE(1, 80);
  bytes.writeUInt16LE(256, 82); bytes.writeUInt16LE(4, 84); bytes.writeUInt32LE(1, 86); bytes.writeUInt32LE(160, 90);
  expect(await readBytes(bytes)).toMatchObject({ width: 640, height: 480, make: 'Acme' });
});
