import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { PhotoPosition } from "../../../../shared/api-types.ts";
import { isBasemapSettings, type BasemapSettings } from "../../../../shared/basemap.ts";
import { api } from "../../api.ts";
import { mapRequest } from "../../basemap/map-request.ts";
import { Button } from "../../controls/Button.tsx";
import { t } from "../../i18n/translate.ts";
import { sameOriginRequest } from "../../map/MapView.tsx";

export default function PositionsMap({ photos }: { photos: PhotoPosition[] }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [basemap, setBasemap] = useState<BasemapSettings | null | undefined>(undefined);
  const [failure, setFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [theme, setTheme] = useState(0);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setTheme(value => value + 1);
    media.addEventListener("change", update);
    const observer = new MutationObserver(update); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { media.removeEventListener("change", update); observer.disconnect(); };
  }, []);
  useEffect(() => {
    let current = true;
    void api<unknown>("GET", "/api/settings/basemap").then(value => {
      if (!isBasemapSettings(value)) throw Error("Invalid basemap");
      if (current) { setBasemap(value.enabled ? value : null); setFailure(false); }
    }).catch(() => { if (current) setFailure(true); });
    return () => { current = false; };
  }, [attempt]);
  const flights = useMemo(() => [...new Set(photos.map(photo => photo.flightId))].sort(), [photos]);
  const flightIndex = useMemo(() => new Map(flights.map((id,index) => [id,index])), [flights]);
  const colours = useMemo(() => {
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    return flights.map((_, index) => `hsl(${Math.round(index * 137.5) % 360}, 65%, ${dark ? 70 : 30}%)`);
  }, [flights, theme]);
  const data = useMemo(() => ({ type: "FeatureCollection" as const, features: photos.filter(photo => photo.latitude !== null && photo.longitude !== null).map(photo => ({
    type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [photo.longitude!,photo.latitude!] },
    properties: { excluded: photo.excluded, colour: colours[flightIndex.get(photo.flightId) ?? 0] },
  })) }), [photos, colours, flightIndex]);
  const latest = useRef(data); latest.current = data;
  useEffect(() => {
    if (!container.current || basemap === undefined) return;
    let instance: maplibregl.Map | undefined;
    let observer: ResizeObserver | undefined;
    setLoaded(false);
    try {
      maplibregl.setWorkerUrl(sameOriginRequest(workerUrl, location.origin).url);
      const background = getComputedStyle(container.current).backgroundColor;
      const sources: Record<string, maplibregl.SourceSpecification> = { photos: { type: "geojson", data: latest.current } };
      const layers: maplibregl.LayerSpecification[] = [{ id: "background", type: "background", paint: { "background-color": background } }];
      if (basemap?.enabled) { sources.basemap = { type: "raster", tiles: [basemap.url], scheme: basemap.scheme, tileSize: 256 }; layers.push({ id: "basemap", type: "raster", source: "basemap" }); }
      layers.push({ id: "photos", type: "circle", source: "photos", paint: { "circle-radius": 5, "circle-stroke-width": 2, "circle-stroke-color": ["get", "colour"], "circle-color": ["get", "colour"], "circle-opacity": ["case", ["get", "excluded"], 0, 1] } });
      instance = new maplibregl.Map({ container: container.current, style: { version: 8, sources, layers }, center: [0,0], zoom: 1, locale: { "Map.Title": t("photos.visual.positions"), "NavigationControl.ZoomIn": t("photos.visual.zoom_in"), "NavigationControl.ZoomOut": t("photos.visual.zoom_out") }, attributionControl: false, transformRequest: (url,resource) => mapRequest(url, location.origin, basemap, resource) });
      map.current = instance;
      instance.getCanvas().setAttribute("aria-label", t("photos.visual.positions"));
      instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      instance.addControl(new maplibregl.ScaleControl(), "bottom-left");
      instance.on("load", () => {
        if (!instance) return;
        const bounds = new maplibregl.LngLatBounds();
        for (const feature of latest.current.features) bounds.extend(feature.geometry.coordinates as [number,number]);
        (instance.getSource("photos") as maplibregl.GeoJSONSource)?.setData(latest.current);
        if (!bounds.isEmpty()) instance.fitBounds(bounds, { padding: 30, maxZoom: 18, duration: 0 });
        setLoaded(true);
      });
      instance.on("error", () => setFailure(true));
      observer = new ResizeObserver(() => instance?.resize()); observer.observe(container.current);
    } catch { setFailure(true); }
    return () => { observer?.disconnect(); map.current = null; instance?.remove(); };
  }, [basemap, attempt, theme]);
  useEffect(() => { if (loaded) (map.current?.getSource("photos") as maplibregl.GeoJSONSource | undefined)?.setData(data); }, [data, loaded]);
  return <div className="photo-positions">
    {failure && <div role="alert"><p>{t("photos.visual.map_failed")}</p><Button variant="secondary" onClick={() => { setFailure(false); setAttempt(value => value + 1); }}>{t("photos.visual.retry")}</Button></div>}
    <div className="photo-positions-canvas" ref={container} />
    {basemap?.enabled && <p>{basemap.attribution}</p>}
    <p>{t("photos.visual.map_key", { count: data.features.length, excluded: data.features.filter(feature => feature.properties.excluded).length })}</p>
    <p>{t("photos.visual.map_keyboard")}</p>
    <ul className="photo-flight-key" aria-label={t("photos.visual.flights")}>
      {flights.map((flight,index) => <li key={flight ?? "unassigned"}><span style={{ backgroundColor: colours[index] }} aria-hidden="true" />{flight ? t("photos.visual.flight_number", { count: index + 1 }) : t("photos.visual.unassigned_label")}</li>)}
    </ul>
  </div>;
}
