import type * as maplibregl from "maplibre-gl";
import type { MapGeoTiffLayer } from "../../../shared/map.ts";
import { chooseLevel, groundPixel, openOrthophoto, overviewLevel, pixelWindow, readWindow, screenPixel, windowCorners, type Orthophoto, type Unreadable } from "./orthophoto-reader.ts";

/** The map's two sources for an orthophoto read from its GeoTIFF: the whole raster coarse, and the view sharp. */
export const ORTHOPHOTO_DETAIL = "orthophoto-detail";

export type OrthophotoState = "reading" | "drawn" | "error" | Unreadable;

/**
 * Draws a GeoTIFF orthophoto on a map that has the image sources
 * `orthophoto` and `orthophoto-detail` on the layer's corners. The whole
 * raster comes from an overview first; after each move, the part in view is
 * read again from the image as sharp as the screen, when the overview is not.
 * Must be called before the map has loaded its style.
 */
export function drawOrthophoto(map: maplibregl.Map, layer: MapGeoTiffLayer, url: string, signal: AbortSignal, report: (state: OrthophotoState) => void): void {
  // The map counts as loaded only once every source has an image, so the images wait for the style alone.
  const styled = new Promise<void>((resolve) => map.once("style.load", () => resolve()));
  let orthophoto: Orthophoto | null = null;
  let overview = 0;
  let detail: AbortController | null = null;
  const source = (id: string) => map.getSource(id) as maplibregl.ImageSource | undefined;
  const hideDetail = () => { if (map.getLayer(ORTHOPHOTO_DETAIL)) map.setPaintProperty(ORTHOPHOTO_DETAIL, "raster-opacity", 0); };

  async function refine() {
    detail?.abort();
    if (!orthophoto || signal.aborted) return;
    const current = new AbortController();
    detail = current;
    const both = AbortSignal.any([signal, current.signal]);
    const { width, height, images } = orthophoto;
    const level = chooseLevel(images.map((image) => image.getWidth()), groundPixel(layer.corners, width), screenPixel(map.getZoom(), map.getCenter().lat, window.devicePixelRatio || 1));
    const bounds = map.getBounds();
    const part = level < overview ? pixelWindow(layer.corners, width, height, [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]) : null;
    if (part === null) { hideDetail(); return; }
    try {
      const read = await readWindow(orthophoto, level, part, both);
      if (both.aborted) return;
      source(ORTHOPHOTO_DETAIL)?.updateImage({ image: new ImageData(read.pixels, read.width, read.height), coordinates: windowCorners(layer.corners, width, height, read.window).map((point) => [...point]) as maplibregl.Coordinates });
      map.setPaintProperty(ORTHOPHOTO_DETAIL, "raster-opacity", 1);
    } catch {
      if (!both.aborted) report("error");
    }
  }

  void (async () => {
    try {
      report("reading");
      const opened = await openOrthophoto(url, signal);
      if (signal.aborted) return;
      if (typeof opened === "string") { report(opened); return; }
      orthophoto = opened;
      overview = overviewLevel(opened.images.map((image) => ({ width: image.getWidth(), height: image.getHeight() })));
      const whole = await readWindow(opened, overview, [0, 0, opened.width, opened.height], signal);
      await styled;
      if (signal.aborted) return;
      source("orthophoto")?.updateImage({ image: new ImageData(whole.pixels, whole.width, whole.height), coordinates: layer.corners.map((point) => [...point]) as maplibregl.Coordinates });
      report("drawn");
      map.on("moveend", refine);
      signal.addEventListener("abort", () => { detail?.abort(); map.off("moveend", refine); }, { once: true });
      void refine();
    } catch {
      if (!signal.aborted) report("error");
    }
  })();
}
