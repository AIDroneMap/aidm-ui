import { afterAll, expect, test } from "bun:test";
import { COMPRESSION, fixtureColour, geoTiffFixture } from "../../../test-support/geotiff-fixture.ts";
import { chooseLevel, groundPixel, openOrthophoto, overviewLevel, pixelWindow, quadPoint, readWindow, screenPixel, toRgba, unreadable, windowCorners, type Corners } from "./orthophoto-reader.ts";

// A raster turned slightly, as a UTM grid is against longitude and latitude.
const corners: Corners = [[10, 20], [12, 20.2], [12.3, 17.2], [10.3, 17]];

test("points inside the raster follow its four corners", () => {
  expect(quadPoint(corners, 0, 0)).toEqual([10, 20]);
  expect(quadPoint(corners, 1, 1)).toEqual([12.3, 17.2]);
  const middle = quadPoint(corners, 0.5, 0.5);
  expect(middle[0]).toBeCloseTo(11.15, 10); expect(middle[1]).toBeCloseTo(18.6, 10);
  expect(windowCorners(corners, 100, 50, [0, 0, 100, 50])).toEqual(corners);
});

test("a view's bounds become the window of the raster under it, with a margin, clamped to the image", () => {
  const square: Corners = [[0, 10], [10, 10], [10, 0], [0, 0]];
  expect(pixelWindow(square, 1000, 1000, [2, 2, 4, 4], 0)).toEqual([200, 600, 400, 800]);
  expect(pixelWindow(square, 1000, 1000, [2, 2, 4, 4], 0.5)).toEqual([100, 500, 500, 900]);
  expect(pixelWindow(square, 1000, 1000, [-50, -50, 50, 50])).toEqual([0, 0, 1000, 1000]);
  expect(pixelWindow(square, 1000, 1000, [20, 20, 30, 30], 0)).toBeNull();
  // On a turned raster the window covers the whole view.
  const window = pixelWindow(corners, 400, 300, [11, 18, 11.5, 18.5], 0)!;
  for (const [lng, lat] of [[11, 18], [11.5, 18], [11.5, 18.5], [11, 18.5]] as const) {
    const inside = windowCorners(corners, 400, 300, window);
    const xs = inside.map(point => point[0]), ys = inside.map(point => point[1]);
    expect(lng).toBeGreaterThanOrEqual(Math.min(...xs)); expect(lng).toBeLessThanOrEqual(Math.max(...xs));
    expect(lat).toBeGreaterThanOrEqual(Math.min(...ys)); expect(lat).toBeLessThanOrEqual(Math.max(...ys));
  }
});

test("the image read is the coarsest one still as sharp as the screen", () => {
  const widths = [8000, 4000, 2000, 1000];
  expect(chooseLevel(widths, 0.05, 0.04)).toBe(0);
  expect(chooseLevel(widths, 0.05, 0.05)).toBe(0);
  expect(chooseLevel(widths, 0.05, 0.12)).toBe(1);
  expect(chooseLevel(widths, 0.05, 0.25)).toBe(2);
  expect(chooseLevel(widths, 0.05, 50)).toBe(3);
  expect(overviewLevel([{ width: 8000, height: 6000 }, { width: 4000, height: 3000 }, { width: 2000, height: 1500 }, { width: 1000, height: 750 }, { width: 500, height: 375 }])).toBe(2);
  expect(overviewLevel([{ width: 600, height: 400 }])).toBe(0);
  // One degree of longitude at the equator is about 111 km.
  expect(groundPixel([[0, 0], [1, 0], [1, -1], [0, -1]], 111_195)).toBeCloseTo(1, 2);
  expect(screenPixel(0, 0, 1)).toBeCloseTo(78271.5, 0);
  expect(screenPixel(1, 60, 2)).toBeCloseTo(78271.5 / 8, 0);
});

test("the map refuses LZMA and anything but 8-bit images, and says which", () => {
  const rgb = { compression: 8, photometric: 2, bitsPerSample: [8, 8, 8, 8], sampleFormat: [1, 1, 1, 1], samples: 4 };
  expect(unreadable(rgb)).toBeNull();
  for (const compression of [1, 5, 7, 8, 32946, 32773, undefined]) expect(unreadable({ ...rgb, compression })).toBeNull();
  expect(unreadable({ ...rgb, compression: 34925 })).toBe("compression");
  expect(unreadable({ ...rgb, bitsPerSample: [16, 16, 16] })).toBe("format");
  expect(unreadable({ ...rgb, sampleFormat: [3, 3, 3, 3] })).toBe("format");
  expect(unreadable({ ...rgb, photometric: 6, samples: 3 })).toBeNull();
  expect(unreadable({ ...rgb, photometric: 1, bitsPerSample: [8], samples: 1 })).toBeNull();
  expect(unreadable({ ...rgb, photometric: 5 })).toBe("format");
  expect([...toRgba([1, 2, 3, 4, 5, 6], 2, 1)]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  expect([...toRgba([1, 2, 3, 0], 1, 1)]).toEqual([1, 2, 3, 0]);
});

const files = new Map<string, Uint8Array>();
const ranges: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const file = files.get(new URL(request.url).pathname);
  if (!file) return new Response(null, { status: 404 });
  const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
  if (!range) return new Response(null, { status: 400 });
  ranges.push(range[0]);
  const start = Number(range[1]), end = Math.min(file.length - 1, Number(range[2]));
  return new Response(file.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${file.length}` } });
} });
afterAll(() => server.stop(true));

test.each([["none", COMPRESSION.none], ["deflate", COMPRESSION.deflate]] as const)("reads a window of a %s orthophoto from its overview and from the full image through range requests", async (_name, compression) => {
  files.set(`/${compression}.tif`, geoTiffFixture({ compression }));
  ranges.length = 0;
  const orthophoto = await openOrthophoto(`http://127.0.0.1:${server.port}/${compression}.tif`);
  if (typeof orthophoto === "string") throw new Error(orthophoto);
  expect(orthophoto.images.map(image => image.getWidth())).toEqual([64, 32]);
  expect([orthophoto.width, orthophoto.height]).toEqual([64, 48]);
  const whole = await readWindow(orthophoto, 1, [0, 0, 64, 48]);
  expect([whole.width, whole.height, whole.window]).toEqual([32, 24, [0, 0, 64, 48]]);
  expect([...whole.pixels.slice(0, 4)]).toEqual([...fixtureColour(0, 0, 64, 48), 255]);
  const detail = await readWindow(orthophoto, 0, [36, 26, 40, 30]);
  expect([detail.width, detail.height, detail.window]).toEqual([4, 4, [36, 26, 40, 30]]);
  expect([...detail.pixels.slice(0, 4)]).toEqual([...fixtureColour(36, 26, 64, 48), 255]);
  expect(ranges.length).toBeGreaterThan(0);
});

test("an LZMA orthophoto is refused after reading its header only", async () => {
  files.set("/lzma.tif", geoTiffFixture({ compression: COMPRESSION.lzma }));
  expect(await openOrthophoto(`http://127.0.0.1:${server.port}/lzma.tif`)).toBe("compression");
});
