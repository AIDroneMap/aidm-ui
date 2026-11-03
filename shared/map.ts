export type MapLayerName = "orthophoto" | "surface" | "ground";
export type LngLat = [number, number];

/** A layer drawn from the engine's map tiles in the archive. */
export interface MapTileLayer {
  kind: "tiles";
  name: MapLayerName;
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  scheme: "xyz" | "tms";
}

/**
 * The orthophoto read from its cloud-optimised GeoTIFF through the output
 * route, when the archive has no orthophoto tiles (ADR 0013). The corners are
 * the raster's top left, top right, bottom right and bottom left, in that
 * order, as longitude and latitude.
 */
export interface MapGeoTiffLayer {
  kind: "cog";
  name: "orthophoto";
  bounds: [number, number, number, number];
  corners: [LngLat, LngLat, LngLat, LngLat];
}

export type MapLayer = MapTileLayer | MapGeoTiffLayer;

export interface RunMapView {
  state: "ready" | "unavailable";
  layers: MapLayer[];
}
