import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ICNS_CHUNKS, ICON_FOLDER, ICON_SIZES, icns, pngSize, readIconPngs } from "./macos-icon.ts";

/** The chunks of an icns file as [type, bytes], after checking its head and lengths. */
function chunksOf(file: Buffer): [string, Buffer][] {
  expect(file.toString("latin1", 0, 4)).toBe("icns");
  expect(file.readUInt32BE(4)).toBe(file.length);
  const chunks: [string, Buffer][] = [];
  let at = 8;
  while (at < file.length) {
    const length = file.readUInt32BE(at + 4);
    expect(length).toBeGreaterThan(8);
    expect(at + length).toBeLessThanOrEqual(file.length);
    chunks.push([file.toString("latin1", at, at + 4), file.subarray(at + 8, at + length)]);
    at += length;
  }
  expect(at).toBe(file.length);
  return chunks;
}

/** A PNG signature and header for the given size: enough for the size check. */
function fakePng(width: number, height = width): Buffer {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "latin1");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test("every committed icon PNG is a PNG of the size its name says", () => {
  for (const size of ICON_SIZES) {
    expect(pngSize(readFileSync(join(ICON_FOLDER, `aidm-ui-${size}.png`)))).toEqual({ width: size, height: size });
  }
});

test("the icns file has its head, the types ic07 to ic14, and each chunk holds the PNG of its size unchanged", () => {
  const pngs = readIconPngs();
  const chunks = chunksOf(icns(pngs));
  expect(chunks.map(([type]) => type)).toEqual(["ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"]);
  const sizes: Record<string, number> = { ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 };
  for (const [type, bytes] of chunks) {
    const size = sizes[type] as number;
    expect(pngSize(bytes)).toEqual({ width: size, height: size });
    expect(bytes.equals(pngs.get(size) as Uint8Array)).toBe(true);
  }
});

test("the chunk lengths count their 8-byte head", () => {
  const pngs = new Map(ICON_SIZES.map((size) => [size, fakePng(size)]));
  const file = icns(pngs);
  expect(file.length).toBe(8 + ICNS_CHUNKS.length * (8 + 33));
  expect(file.readUInt32BE(8 + 4)).toBe(8 + 33);
});

test("a missing size, a PNG of another size, or bytes that are not a PNG are refused", () => {
  const good = () => new Map(ICON_SIZES.map((size) => [size, fakePng(size)]));
  const missing = good();
  missing.delete(1024);
  expect(() => icns(missing)).toThrow("1024 by 1024 PNG");
  const wrong = good();
  wrong.set(256, fakePng(255, 256));
  expect(() => icns(wrong)).toThrow("256 by 256 PNG");
  const notPng = good();
  notPng.set(128, Buffer.from("<svg/>"));
  expect(() => icns(notPng)).toThrow("128 by 128 PNG");
  expect(pngSize(Buffer.from("short"))).toBeNull();
});
