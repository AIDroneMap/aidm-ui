import type { MapLayer, MapLayerName, RunMapView } from "../../shared/map.ts";
import { readGeoreference } from "./georeference.ts";
import type { ArchiveEntry } from "./zip.ts";

const LAYERS: Array<{ name: MapLayerName; root: string; raster: string }> = [
  { name: "orthophoto", root: "orthophoto_tiles", raster: "odm_orthophoto/odm_orthophoto.tif" },
  { name: "surface", root: "dsm_tiles", raster: "odm_dem/dsm.tif" },
  { name: "ground", root: "dtm_tiles", raster: "odm_dem/dtm.tif" },
];
const MERCATOR_LIMIT = 85.0511287798066;

function row(latitude: number, count: number): number {
  const radians = latitude * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * count;
}

/** Match file numbering to the raster, since archives can contain either tile scheme. */
export async function readMapMetadata(path: string, entries: readonly ArchiveEntry[]): Promise<RunMapView> {
  const layers: MapLayer[] = [];
  for (const definition of LAYERS) {
    const raster = entries.find(entry => entry.name === definition.raster);
    if (!raster) continue;
    const tiles = entries.flatMap(entry => {
      if (!entry.name.startsWith(`${definition.root}/`)) return [];
      const match = /^(\d{1,2})\/(\d{1,10})\/(\d{1,10})\.png$/.exec(entry.name.slice(definition.root.length + 1));
      if (!match) return [];
      const [z, x, y] = match.slice(1).map(Number) as [number, number, number];
      if (z > 30 || x >= 2 ** z || y >= 2 ** z) return [];
      return [{ z, x, y }];
    });
    if (!tiles.length) continue;
    const georeference = await readGeoreference(path, raster);
    if (!georeference) continue;
    const bounds = georeference.bounds;
    const [west, south, east, north] = bounds;
    if (south < -MERCATOR_LIMIT || north > MERCATOR_LIMIT) continue;
    let xyz = true, tms = true;
    for (const tile of tiles) {
      const count = 2 ** tile.z;
      const left = (west + 180) / 360 * count, right = (east + 180) / 360 * count;
      const top = row(north, count), bottom = row(south, count);
      const overlaps = (y: number) => tile.x + 1 > left + 1e-8 && tile.x < right - 1e-8 && y + 1 > top + 1e-8 && y < bottom - 1e-8;
      xyz &&= overlaps(tile.y);
      tms &&= overlaps(count - 1 - tile.y);
    }
    if (!xyz && !tms) continue;
    // At zoom zero the schemes address the same file. Otherwise ambiguity hides the layer.
    if (xyz && tms && tiles.some(tile => tile.z !== 0)) continue;
    layers.push({ name: definition.name, bounds, scheme: xyz ? "xyz" : "tms", minZoom: tiles.reduce((min, tile) => Math.min(min, tile.z), 30), maxZoom: tiles.reduce((max, tile) => Math.max(max, tile.z), 0) });
  }
  return { state: layers.length ? "ready" : "unavailable", layers };
}
