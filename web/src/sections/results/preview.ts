import type { MapTileLayer } from "../../../../shared/map.ts";

/**
 * The engine's tile at its lowest zoom under the middle of the layer, named
 * as the archive names it, for the preview strip of the map tile.
 */
export function previewTile(layer: MapTileLayer): { z: number; x: number; y: number } {
  const [west, south, east, north] = layer.bounds;
  const z = layer.minZoom, count = 2 ** z;
  const longitude = (west + east) / 2, latitude = (south + north) / 2 * Math.PI / 180;
  const clamp = (value: number) => Math.min(count - 1, Math.max(0, Math.floor(value)));
  const x = clamp((longitude + 180) / 360 * count);
  const y = clamp((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * count);
  return { z, x, y: layer.scheme === "tms" ? count - 1 - y : y };
}

export function previewTileUrl(runId: number, layer: MapTileLayer): string {
  const { z, x, y } = previewTile(layer);
  return `/api/runs/${runId}/tiles/${layer.name}/${z}/${x}/${y}.png`;
}
