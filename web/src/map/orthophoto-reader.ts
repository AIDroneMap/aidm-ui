import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import type { LngLat } from "../../../shared/map.ts";

/**
 * Reads the orthophoto's cloud-optimised GeoTIFF from the archive in place
 * (ADR 0013): the header first, then only the internal tiles a view needs,
 * through the output route's range requests. The map shows the result as an
 * image laid on the raster's four corners.
 */

export type Corners = readonly [LngLat, LngLat, LngLat, LngLat];
/** A part of an image in its own pixels: left, top, right, bottom. */
export type PixelWindow = [number, number, number, number];
/** Why the map cannot draw an orthophoto, as a key under `results.map.`. */
export type Unreadable = "compression" | "format";

/**
 * The compressions the engine offers that the reader decodes: none, LZW,
 * JPEG, deflate (both codes) and PackBits. The engine's other choice, LZMA, is
 * not among them, so the map says why instead of drawing nothing.
 */
const DECODED = new Set([1, 5, 7, 8, 32946, 32773]);
const RGB = 2, BLACK_IS_ZERO = 1, YCBCR = 6;
/** The widest image the map asks the reader for in one go, in pixels per side. */
export const MAX_SIDE = 2048;
const EARTH_CIRCUMFERENCE = 40075016.686;

/** A point inside the raster, from fractions of its width and height, as longitude and latitude. */
export function quadPoint(corners: Corners, u: number, v: number): LngLat {
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  const top: LngLat = [topLeft[0] + (topRight[0] - topLeft[0]) * u, topLeft[1] + (topRight[1] - topLeft[1]) * u];
  const bottom: LngLat = [bottomLeft[0] + (bottomRight[0] - bottomLeft[0]) * u, bottomLeft[1] + (bottomRight[1] - bottomLeft[1]) * u];
  return [top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v];
}

/** The corners of a window of an image of the given size, in the order of the raster's corners. */
export function windowCorners(corners: Corners, width: number, height: number, [left, top, right, bottom]: PixelWindow): Corners {
  return [quadPoint(corners, left / width, top / height), quadPoint(corners, right / width, top / height), quadPoint(corners, right / width, bottom / height), quadPoint(corners, left / width, bottom / height)];
}

/**
 * The part of an image of the given size that covers a view's bounds (west,
 * south, east, north), widened by a margin of the view's size, or null when
 * they do not meet. Over the few kilometres of a flight the raster's corners
 * are a parallelogram to well under a pixel, so the inverse is affine.
 */
export function pixelWindow(corners: Corners, width: number, height: number, view: readonly [number, number, number, number], margin = 0.25): PixelWindow | null {
  const [origin, right, , below] = corners;
  const ax = right[0] - origin[0], ay = right[1] - origin[1];
  const bx = below[0] - origin[0], by = below[1] - origin[1];
  const determinant = ax * by - ay * bx;
  if (determinant === 0) return null;
  const [west, south, east, north] = view;
  const padX = (east - west) * margin, padY = (north - south) * margin;
  const points: LngLat[] = [[west - padX, south - padY], [east + padX, south - padY], [east + padX, north + padY], [west - padX, north + padY]];
  const pixels = points.map(([lng, lat]) => {
    const dx = lng - origin[0], dy = lat - origin[1];
    return [(dx * by - dy * bx) / determinant * width, (ax * dy - ay * dx) / determinant * height];
  });
  const left = Math.max(0, Math.floor(Math.min(...pixels.map(point => point[0]!))));
  const top = Math.max(0, Math.floor(Math.min(...pixels.map(point => point[1]!))));
  const rightEdge = Math.min(width, Math.ceil(Math.max(...pixels.map(point => point[0]!))));
  const bottom = Math.min(height, Math.ceil(Math.max(...pixels.map(point => point[1]!))));
  return left < rightEdge && top < bottom ? [left, top, rightEdge, bottom] : null;
}

function metres(a: LngLat, b: LngLat): number {
  const radians = Math.PI / 180;
  const dLat = (b[1] - a[1]) * radians, dLng = (b[0] - a[0]) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

/** The ground size of one pixel of the full image, in metres, from the raster's top edge. */
export function groundPixel(corners: Corners, width: number): number {
  return metres(corners[0], corners[1]) / width;
}

/** The ground size of one screen pixel at a map zoom and latitude, in metres, as MapLibre draws it. */
export function screenPixel(zoom: number, latitude: number, pixelRatio: number): number {
  return EARTH_CIRCUMFERENCE * Math.cos(latitude * Math.PI / 180) / (512 * 2 ** zoom) / pixelRatio;
}

/**
 * Which image to read, given each image's width, finest first: the coarsest
 * one whose pixels are no larger than the screen's, so the view is sharp and
 * no more is read than the screen can show.
 */
export function chooseLevel(widths: readonly number[], fullGroundPixel: number, screenGroundPixel: number): number {
  let chosen = 0;
  widths.forEach((width, index) => { if (fullGroundPixel * widths[0]! / width <= screenGroundPixel) chosen = index; });
  return chosen;
}

/** The coarsest image whose longer side still has at least the given pixels, for the whole-raster picture. */
export function overviewLevel(sizes: ReadonlyArray<{ width: number; height: number }>, side = 1024): number {
  let chosen = 0;
  sizes.forEach((size, index) => { if (Math.max(size.width, size.height) >= side) chosen = index; });
  return chosen;
}

/** The facts of an image that decide whether the map can draw it. */
export interface ImageFacts { compression: number | undefined; photometric: number | undefined; bitsPerSample: readonly number[]; sampleFormat: readonly number[] | undefined; samples: number }

export function unreadable(facts: ImageFacts): Unreadable | null {
  if (!DECODED.has(facts.compression ?? 1)) return "compression";
  if (facts.bitsPerSample.some(bits => bits !== 8) || (facts.sampleFormat ?? []).some(format => format !== 1)) return "format";
  if (facts.photometric === RGB || facts.photometric === YCBCR) return facts.samples >= 3 ? null : "format";
  return facts.photometric === BLACK_IS_ZERO ? null : "format";
}

function factsOf(image: GeoTIFFImage): ImageFacts {
  const directory = image.getFileDirectory();
  const bits = directory.getValue("BitsPerSample") as ArrayLike<number> | number | undefined;
  const formats = directory.getValue("SampleFormat") as ArrayLike<number> | number | undefined;
  const list = (value: ArrayLike<number> | number | undefined) => value === undefined ? undefined : typeof value === "number" ? [value] : Array.from(value);
  return {
    compression: directory.getValue("Compression") as number | undefined,
    photometric: directory.getValue("PhotometricInterpretation") as number | undefined,
    bitsPerSample: list(bits) ?? [],
    sampleFormat: list(formats),
    samples: image.getSamplesPerPixel(),
  };
}

/** Turns what the reader returns, grey, RGB or RGBA, into the four channels an image needs. */
export function toRgba(pixels: ArrayLike<number>, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const channels = pixels.length / (width * height);
  if (channels !== 3 && channels !== 4) throw new Error("Unexpected sample count");
  const out = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    out[pixel * 4] = pixels[pixel * channels]!;
    out[pixel * 4 + 1] = pixels[pixel * channels + 1]!;
    out[pixel * 4 + 2] = pixels[pixel * channels + 2]!;
    out[pixel * 4 + 3] = channels === 4 ? pixels[pixel * channels + 3]! : 255;
  }
  return out;
}

export interface Orthophoto {
  /** The full image first, then its overviews, finest first. */
  images: GeoTIFFImage[];
  width: number;
  height: number;
}

/** Opens the orthophoto. Reads only the header and the image directories. */
export async function openOrthophoto(url: string, signal?: AbortSignal): Promise<Orthophoto | Unreadable> {
  const tiff: GeoTIFF = await fromUrl(url, { allowFullFile: false, credentials: "same-origin" } as Parameters<typeof fromUrl>[1], signal);
  const count = await tiff.getImageCount();
  const primary = await tiff.getImage(0);
  if (Number(primary.getFileDirectory().getValue("NewSubfileType") ?? 0) & 4) return "format";
  const images = [primary];
  for (let index = 1; index < count; index++) {
    const image = await tiff.getImage(index);
    const kind = Number(image.getFileDirectory().getValue("NewSubfileType") ?? 0);
    // Reduced copies only. Transparency masks are images of their own and are skipped.
    if (kind & 1 && !(kind & 4)) images.push(image);
  }
  const problem = unreadable(factsOf(primary));
  if (problem) return problem;
  images.sort((a, b) => b.getWidth() - a.getWidth());
  return { images, width: primary.getWidth(), height: primary.getHeight() };
}

/**
 * Reads a window of the full image from one of its images, scaled to that
 * image's pixels and no larger than MAX_SIDE a side, as RGBA pixels with the
 * window they actually cover in full-image pixels.
 */
export async function readWindow(orthophoto: Orthophoto, level: number, window: PixelWindow, signal?: AbortSignal): Promise<{ pixels: Uint8ClampedArray<ArrayBuffer>; width: number; height: number; window: PixelWindow }> {
  const image = orthophoto.images[level]!;
  const scaleX = image.getWidth() / orthophoto.width, scaleY = image.getHeight() / orthophoto.height;
  const own: PixelWindow = [
    Math.max(0, Math.floor(window[0] * scaleX)), Math.max(0, Math.floor(window[1] * scaleY)),
    Math.min(image.getWidth(), Math.ceil(window[2] * scaleX)), Math.min(image.getHeight(), Math.ceil(window[3] * scaleY)),
  ];
  const across = own[2] - own[0], down = own[3] - own[1];
  const shrink = Math.min(1, MAX_SIDE / Math.max(across, down));
  const width = Math.max(1, Math.round(across * shrink)), height = Math.max(1, Math.round(down * shrink));
  const pixels = await image.readRGB({ window: own, width, height, interleave: true, enableAlpha: true, signal });
  return {
    pixels: toRgba(pixels as unknown as ArrayLike<number>, width, height), width, height,
    window: [own[0] / scaleX, own[1] / scaleY, own[2] / scaleX, own[3] / scaleY],
  };
}
