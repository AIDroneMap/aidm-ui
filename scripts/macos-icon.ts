// Writes the Mac app's icon, "AIDM UI.icns", from the PNGs in assets/icon/.
// Those PNGs are rendered from assets/icon/aidm-ui.svg, the source of truth.
//
//   bun scripts/macos-icon.ts <output file>
//
// An icns file is the four letters "icns" and the file's length, then one
// chunk per image: a four-letter type, the chunk's length with its 8-byte
// head, and the PNG file's bytes unchanged. Lengths are big-endian.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ICON_FOLDER = join(import.meta.dir, "..", "assets", "icon");

/** The PNG sizes in assets/icon/, as aidm-ui-<size>.png. The icns file uses all but 16. */
export const ICON_SIZES = [16, 32, 64, 128, 256, 512, 1024] as const;

/**
 * Each chunk type and the pixel size of the PNG it holds: ic07 to ic10 at 1x,
 * ic11 to ic14 at 2x. macOS draws the 16 pixel size from these.
 */
export const ICNS_CHUNKS: readonly (readonly [type: string, size: number])[] = [
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024], // 512 at 2x
  ["ic11", 32], // 16 at 2x
  ["ic12", 64], // 32 at 2x
  ["ic13", 256], // 128 at 2x
  ["ic14", 512], // 256 at 2x
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The width and height in a PNG's header, or null when the bytes are not a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The icns bytes for PNGs keyed by pixel size. A missing size, or a PNG of another size, is refused. */
export function icns(pngs: ReadonlyMap<number, Uint8Array>): Buffer {
  const chunks = ICNS_CHUNKS.map(([type, size]) => {
    const png = pngs.get(size);
    if (png === undefined) throw new Error(`The icon needs a ${size} by ${size} PNG.`);
    const found = pngSize(png);
    if (found === null || found.width !== size || found.height !== size) {
      throw new Error(`The icon's ${size} pixel image must be a ${size} by ${size} PNG.`);
    }
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32BE(8 + png.byteLength, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

/** Reads assets/icon/aidm-ui-<size>.png for every size. */
export function readIconPngs(folder: string = ICON_FOLDER): Map<number, Uint8Array> {
  return new Map(ICON_SIZES.map((size) => [size, readFileSync(join(folder, `aidm-ui-${size}.png`))]));
}

/** Writes the icns file from the PNGs in the folder. */
export function writeIcns(file: string, folder: string = ICON_FOLDER): void {
  writeFileSync(file, icns(readIconPngs(folder)));
}

if (import.meta.main) {
  const [file] = process.argv.slice(2);
  if (file === undefined) {
    console.error("usage: bun scripts/macos-icon.ts <output file>");
    process.exit(2);
  }
  writeIcns(file);
  console.log(`Wrote ${file}`);
}
