import { deflateSync } from "node:zlib";

/** The TIFF compression codes the fixture can claim. LZMA is claimed only: its tiles hold raw bytes. */
export const COMPRESSION = { none: 1, deflate: 8, lzma: 34925 } as const;

type Tag = [tag: number, type: 3 | 4 | 12, values: number[]];

/** The colour of a fixture pixel: four coloured quarters, so a test can tell where the image landed. */
export function fixtureColour(x: number, y: number, width: number, height: number): [number, number, number] {
  const right = x >= width / 2, bottom = y >= height / 2;
  return !right && !bottom ? [220, 30, 30] : right && !bottom ? [30, 160, 40] : !right ? [30, 60, 220] : [230, 200, 20];
}

/**
 * A small cloud-optimised GeoTIFF as the engine makes one: RGBA, 8 bits,
 * tiled, with one overview, in a UTM zone. No survey data: the pixels are four
 * coloured quarters. The primary image's top left corner sits at the given
 * easting and northing with square pixels of the given size in metres.
 */
export function geoTiffFixture({ width = 64, height = 48, tile = 16, compression = COMPRESSION.none, epsg = 32615, easting = 576000, northing = 5188000, pixelSize = 0.5 }: {
  width?: number; height?: number; tile?: number; compression?: number; epsg?: number; easting?: number; northing?: number; pixelSize?: number;
} = {}): Uint8Array<ArrayBuffer> {
  const levels = [{ width, height, step: 1 }, { width: Math.ceil(width / 2), height: Math.ceil(height / 2), step: 2 }];
  const tilesOf = (level: { width: number; height: number; step: number }) => {
    const across = Math.ceil(level.width / tile), down = Math.ceil(level.height / tile);
    const tiles: Uint8Array[] = [];
    for (let row = 0; row < down; row++) for (let column = 0; column < across; column++) {
      const raw = new Uint8Array(tile * tile * 4);
      for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
        const px = column * tile + x, py = row * tile + y;
        if (px >= level.width || py >= level.height) continue;
        const [r, g, b] = fixtureColour(px * level.step, py * level.step, width, height);
        raw.set([r, g, b, 255], (y * tile + x) * 4);
      }
      tiles.push(compression === COMPRESSION.deflate ? new Uint8Array(deflateSync(raw)) : raw);
    }
    return tiles;
  };
  const images = levels.map(level => ({ level, tiles: tilesOf(level) }));
  const ifdSize = (tags: Tag[]) => 2 + tags.length * 12 + 4 + tags.reduce((sum, [, type, values]) => {
    const bytes = values.length * (type === 3 ? 2 : type === 4 ? 4 : 8);
    return sum + (bytes > 4 ? bytes : 0);
  }, 0);
  const tagsFor = (index: number, offsets: number[]): Tag[] => {
    const { level, tiles } = images[index]!;
    const tags: Tag[] = [
      [254, 4, [index === 0 ? 0 : 1]],
      [256, 4, [level.width]], [257, 4, [level.height]],
      [258, 3, [8, 8, 8, 8]], [259, 3, [compression]], [262, 3, [2]], [277, 3, [4]], [284, 3, [1]],
      [322, 3, [tile]], [323, 3, [tile]],
      [324, 4, offsets.length ? offsets : tiles.map(() => 0)], [325, 4, tiles.map(data => data.length)],
      [338, 3, [2]], [339, 3, [1, 1, 1, 1]],
    ];
    if (index === 0) tags.push(
      [33550, 12, [pixelSize, pixelSize, 0]],
      [33922, 12, [0, 0, 0, easting, northing, 0]],
      [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg]],
    );
    return tags;
  };
  // Directories first, as a cloud-optimised file has them, then the tile data.
  const ifdOffsets: number[] = [];
  let at = 8;
  for (let index = 0; index < images.length; index++) { ifdOffsets.push(at); at += ifdSize(tagsFor(index, [])); at += at % 2; }
  const tileOffsets = images.map(({ tiles }) => tiles.map(data => { const offset = at; at += data.length; return offset; }));
  const out = Buffer.alloc(at);
  out.write("II", 0); out.writeUInt16LE(42, 2); out.writeUInt32LE(ifdOffsets[0]!, 4);
  images.forEach((image, index) => {
    const tags = tagsFor(index, tileOffsets[index]!);
    let position = ifdOffsets[index]!;
    let extra = position + 2 + tags.length * 12 + 4;
    out.writeUInt16LE(tags.length, position); position += 2;
    for (const [tag, type, values] of tags) {
      const width = type === 3 ? 2 : type === 4 ? 4 : 8;
      out.writeUInt16LE(tag, position); out.writeUInt16LE(type, position + 2); out.writeUInt32LE(values.length, position + 4);
      const inline = values.length * width <= 4;
      const target = inline ? position + 8 : extra;
      if (!inline) { out.writeUInt32LE(extra, position + 8); extra += values.length * width; }
      values.forEach((value, i) => {
        if (type === 3) out.writeUInt16LE(value, target + i * 2);
        else if (type === 4) out.writeUInt32LE(value, target + i * 4);
        else out.writeDoubleLE(value, target + i * 8);
      });
      position += 12;
    }
    out.writeUInt32LE(ifdOffsets[index + 1] ?? 0, position);
    image.tiles.forEach((data, tileIndex) => out.set(data, tileOffsets[index]![tileIndex]!));
  });
  return new Uint8Array(out.buffer, out.byteOffset, out.length) as Uint8Array<ArrayBuffer>;
}
