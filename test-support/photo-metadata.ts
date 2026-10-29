export function tiff(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.write('II');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(3, 8);
  for (const [index, tag, type, count, value] of [
    [0, 256, 4, 1, 640], [1, 257, 4, 1, 480], [2, 271, 2, 5, 50],
  ] as const) {
    const offset = 10 + index * 12;
    bytes.writeUInt16LE(tag, offset);
    bytes.writeUInt16LE(type, offset + 2);
    bytes.writeUInt32LE(count, offset + 4);
    bytes.writeUInt32LE(value, offset + 8);
  }
  bytes.write('Acme\0', 50);
  return bytes;
}

export function jpeg(): Buffer {
  const data = Buffer.concat([Buffer.from('Exif\0\0'), tiff()]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), header, data, Buffer.from([0xff, 0xd9])]);
}

export function detailedTiff(little: boolean): Buffer {
  const bytes = Buffer.alloc(512);
  const u16 = (value: number, offset: number) => little ? bytes.writeUInt16LE(value, offset) : bytes.writeUInt16BE(value, offset);
  const u32 = (value: number, offset: number) => little ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  bytes.write(little ? 'II' : 'MM'); u16(42, 2); u32(8, 4);
  const entry = (offset: number, tag: number, type: number, count: number, value: number) => {
    u16(tag, offset); u16(type, offset + 2); u32(count, offset + 4); u32(value, offset + 8);
  };
  u16(3, 8); entry(10, 272, 2, 6, 300); entry(22, 34665, 4, 1, 80); entry(34, 34853, 4, 1, 150);
  u16(3, 80); entry(82, 36867, 2, 20, 310); entry(94, 37521, 2, 4, 0); bytes.write('123\0', 102); entry(106, 36881, 2, 7, 330);
  u16(6, 150); entry(152, 1, 2, 2, 0); bytes.write('S\0', 160); entry(164, 2, 5, 3, 350); entry(176, 3, 2, 2, 0); bytes.write('W\0', 184); entry(188, 4, 5, 3, 374); entry(200, 5, 1, 1, 0); bytes[208] = 1; entry(212, 6, 5, 1, 398);
  bytes.write('Model\0', 300); bytes.write('2024:02:29 12:34:56\0', 310); bytes.write('+05:30\0', 330);
  for (const [offset, value] of [[350, 12], [358, 30], [366, 0], [374, 45], [382, 15], [390, 0], [398, 25]] as const) { u32(value, offset); u32(1, offset + 4); }
  return bytes;
}

export function png(): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(name), data, Buffer.alloc(4)]);
  };
  const dimensions = Buffer.alloc(13); dimensions.writeUInt32BE(320, 0); dimensions.writeUInt32BE(240, 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', dimensions), chunk('eXIf', tiff()), chunk('IEND', Buffer.alloc(0))]);
}

export function jpegXl(): Buffer {
  const box = (name: string, data: Buffer) => {
    const header = Buffer.alloc(8); header.writeUInt32BE(data.length + 8); header.write(name, 4);
    return Buffer.concat([header, data]);
  };
  return Buffer.concat([Buffer.from([0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20, 13, 10, 0x87, 10]), box('Exif', Buffer.concat([Buffer.alloc(4), tiff()]))]);
}

export function jpegXlXmp(xml: string): Buffer {
  const data = Buffer.from(xml); const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length + 8); header.write('xml ', 4);
  return Buffer.concat([jpegXl(), header, data]);
}

export function jpegXmp(xml: string): Buffer {
  const data = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xml)]);
  const header = Buffer.alloc(4); header.writeUInt16BE(0xffe1); header.writeUInt16BE(data.length + 2, 2);
  const exif = jpeg();
  return Buffer.concat([exif.subarray(0, 2), header, data, exif.subarray(2)]);
}

export function pngXmp(xml: string, language = '', translatedKeyword = '', compressed = false): Buffer {
  const source = png();
  const data = Buffer.concat([Buffer.from('XML:com.adobe.xmp\0'), Buffer.from([compressed ? 1 : 0, 0]), Buffer.from(language + '\0' + translatedKeyword + '\0' + xml)]);
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length); header.write('iTXt', 4);
  return Buffer.concat([source.subarray(0, -12), header, data, Buffer.alloc(4), source.subarray(-12)]);
}
