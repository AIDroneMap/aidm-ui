export type MapLayerName = "orthophoto" | "surface" | "ground";
export interface MapLayer {
  name: MapLayerName;
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  scheme: "xyz" | "tms";
}
export interface RunMapView {
  state: "ready" | "unavailable";
  layers: MapLayer[];
}
