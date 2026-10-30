import type { RequestParameters } from "maplibre-gl";
import { basemapOrigin, type BasemapSettings } from "../../../shared/basemap.ts";

/** External reads are confined to the operator's saved raster tile template. */
export function mapRequest(url: string, origin: string, basemap: BasemapSettings | null, resource: string | undefined): RequestParameters {
  const parsed = new URL(url, origin);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Blocked map request");
  if (parsed.origin === origin) return { url: parsed.href };
  if (resource !== "Tile" || !basemap || basemapOrigin(basemap) !== parsed.origin) throw new Error("Blocked map request");
  let marker = "aidm_tile_";
  while (basemap.url.includes(marker)) marker += "_";
  const template = new URL(basemap.url.replace(/\{([zxy])\}/g, (_, axis: string) => marker + axis)).href;
  const token = new RegExp(`(${marker}[zxy])`, "g");
  const pattern = template.split(token).map(part => part.startsWith(marker) ? "[0-9]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  if (!new RegExp(`^${pattern}$`).test(parsed.href)) throw new Error("Blocked map request");
  return { url: parsed.href, credentials: "same-origin", referrerPolicy: "no-referrer" };
}
