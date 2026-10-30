import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { BasemapSettings } from "../../../shared/basemap.ts";
import { mapRequest } from "../basemap/map-request.ts";
import type { MapLayer } from "../../../shared/map.ts";
import { t } from "../i18n/translate.ts";
import { sameOriginRequest } from "./MapView.tsx";
import "./map.css";

export default function MapCanvas({ runId, layers, basemap, onRetry }: { runId: string; layers: MapLayer[]; basemap: BasemapSettings | null; onRetry: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const camera = useRef<{ runId: string; center: [number, number]; zoom: number; bearing: number; pitch: number } | null>(null);
  const [visible, setVisible] = useState(() => Object.fromEntries(layers.map((layer, index) => [layer.name, index === 0])));
  const [coordinates, setCoordinates] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [basemapFailed, setBasemapFailed] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    maplibregl.setWorkerUrl(sameOriginRequest(workerUrl, location.origin).url);
    const bounds: [number, number, number, number] = [Math.min(...layers.map(layer => layer.bounds[0])), Math.min(...layers.map(layer => layer.bounds[1])), Math.max(...layers.map(layer => layer.bounds[2])), Math.max(...layers.map(layer => layer.bounds[3]))];
    setFailed(false); setBasemapFailed(false); setLoaded(false);
    const sources: Record<string, maplibregl.SourceSpecification> = Object.fromEntries(layers.map(layer => [layer.name, { type: "raster", tiles: [`${location.origin}/api/runs/${encodeURIComponent(runId)}/tiles/${layer.name}/{z}/{x}/{y}.png`], bounds: layer.bounds, minzoom: layer.minZoom, maxzoom: layer.maxZoom, scheme: layer.scheme, tileSize: 256 }]));
    const styleLayers: maplibregl.LayerSpecification[] = layers.map((layer, index) => ({ id: layer.name, type: "raster", source: layer.name, layout: { visibility: (visible[layer.name] ?? index === 0) ? "visible" : "none" } }));
    if (basemap?.enabled) {
      sources["operator-basemap"] = { type: "raster", tiles: [basemap.url], scheme: basemap.scheme, tileSize: 256 };
      styleLayers.unshift({ id: "operator-basemap", type: "raster", source: "operator-basemap" });
    }
    const savedCamera = camera.current?.runId === runId ? camera.current : null;
    const instance = new maplibregl.Map({
      container: container.current,
      style: { version: 8, sources, layers: styleLayers },
      ...(savedCamera ? { center: savedCamera.center, zoom: savedCamera.zoom, bearing: savedCamera.bearing, pitch: savedCamera.pitch } : { bounds, fitBoundsOptions: { padding: 20 } }),
      transformRequest: (url, resource) => mapRequest(url, location.origin, basemap, resource),
      attributionControl: false,
    });
    map.current = instance;
    instance.getCanvas().setAttribute("aria-label", t("map.canvas"));
    instance.addControl(new maplibregl.ScaleControl(), "bottom-left");
    const update = () => {
      const center = instance.getCenter();
      if (center.lng < bounds[0] || center.lng > bounds[2] || center.lat < bounds[1] || center.lat > bounds[3]) { setCoordinates(null); return; }
      setCoordinates(t("map.coordinates", { latitude: center.lat.toFixed(6), longitude: center.lng.toFixed(6) }));
    };
    instance.on("move", update);
    instance.on("load", () => setLoaded(true));
    instance.on("error", event => {
      if ("sourceId" in event && event.sourceId === "operator-basemap") setBasemapFailed(true);
      else setFailed(true);
    });
    update();
    return () => {
      const center = instance.getCenter();
      camera.current = { runId, center: [center.lng, center.lat], zoom: instance.getZoom(), bearing: instance.getBearing(), pitch: instance.getPitch() };
      map.current = null; instance.remove();
    };
  }, [runId, layers, basemap]);

  function toggle(layer: MapLayer) {
    const next = !visible[layer.name];
    setVisible(current => ({ ...current, [layer.name]: next }));
    if (map.current?.getLayer(layer.name)) map.current.setLayoutProperty(layer.name, "visibility", next ? "visible" : "none");
  }

  return <div>
    <fieldset disabled={!loaded}><legend>{t("map.layers")}</legend>{layers.map(layer => <label key={layer.name}><input type="checkbox" checked={visible[layer.name] ?? false} onChange={() => toggle(layer)} /> {t(`map.layer.${layer.name}`)}</label>)}</fieldset>
    {basemapFailed && basemap && <p role="alert">{t("basemap.failed", { url: basemap.url })}</p>}
    {failed && <div role="alert"><p>{t("map.tile_error")}</p><button onClick={onRetry}>{t("map.retry")}</button></div>}
    <div ref={container} className={coordinates ? "result-map" : "result-map map-outside"} />
    {basemap?.enabled && <p className="basemap-attribution" aria-label={t("basemap.attribution")}>{basemap.attribution}</p>}
    {coordinates && <p aria-live="off">{coordinates}</p>}
    <p>{t("map.keyboard")}</p>
  </div>;
}
