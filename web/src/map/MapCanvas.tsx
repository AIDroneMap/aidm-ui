import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { BasemapSettings } from "../../../shared/basemap.ts";
import { mapRequest } from "../basemap/map-request.ts";
import type { MapLayer } from "../../../shared/map.ts";
import { Button } from "../controls/Button.tsx";
import { Checkbox } from "../controls/Checkbox.tsx";
import { Toolbar } from "../controls/Toolbar.tsx";
import { IconArrowLeft } from "../icons/icons.tsx";
import { t } from "../i18n/translate.ts";
import { sameOriginRequest } from "./MapView.tsx";
import { drawOrthophoto, ORTHOPHOTO_DETAIL, type OrthophotoState } from "./orthophoto-layer.ts";
import "./map.css";

const BASEMAP = "operator-basemap";

type Props = {
  runId: string;
  layers: MapLayer[];
  basemap: BasemapSettings | null;
  onRetry: () => void;
  /** The address of the run's results. Given, the map takes the whole content area under one toolbar that leads back there. */
  back?: string;
};

export default function MapCanvas({ runId, layers, basemap, onRetry, back }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const camera = useRef<{ runId: string; center: [number, number]; zoom: number; bearing: number; pitch: number } | null>(null);
  const [visible, setVisible] = useState(() => Object.fromEntries(layers.map((layer, index) => [layer.name, index === 0])));
  const [coordinates, setCoordinates] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [basemapFailed, setBasemapFailed] = useState(false);
  const [basemapShown, setBasemapShown] = useState(true);
  const [orthophoto, setOrthophoto] = useState<OrthophotoState | null>(null);

  useEffect(() => {
    if (!container.current) return;
    maplibregl.setWorkerUrl(sameOriginRequest(workerUrl, location.origin).url);
    const bounds: [number, number, number, number] = [Math.min(...layers.map(layer => layer.bounds[0])), Math.min(...layers.map(layer => layer.bounds[1])), Math.max(...layers.map(layer => layer.bounds[2])), Math.max(...layers.map(layer => layer.bounds[3]))];
    setFailed(false); setBasemapFailed(false); setLoaded(false); setOrthophoto(null);
    const sources: Record<string, maplibregl.SourceSpecification> = {};
    const styleLayers: maplibregl.LayerSpecification[] = [];
    layers.forEach((layer, index) => {
      const visibility = (visible[layer.name] ?? index === 0) ? "visible" : "none";
      if (layer.kind === "cog") {
        // Two images on the raster's corners: the whole orthophoto from an overview, and the part in view, sharper.
        const coordinates = layer.corners.map(point => [...point]) as maplibregl.Coordinates;
        sources[layer.name] = { type: "image", coordinates };
        sources[ORTHOPHOTO_DETAIL] = { type: "image", coordinates };
        styleLayers.push({ id: layer.name, type: "raster", source: layer.name, layout: { visibility }, paint: { "raster-fade-duration": 0 } });
        styleLayers.push({ id: ORTHOPHOTO_DETAIL, type: "raster", source: ORTHOPHOTO_DETAIL, layout: { visibility }, paint: { "raster-fade-duration": 0 } });
      } else {
        sources[layer.name] = { type: "raster", tiles: [`${location.origin}/api/runs/${encodeURIComponent(runId)}/tiles/${layer.name}/{z}/{x}/{y}.png`], bounds: layer.bounds, minzoom: layer.minZoom, maxzoom: layer.maxZoom, scheme: layer.scheme, tileSize: 256 };
        styleLayers.push({ id: layer.name, type: "raster", source: layer.name, layout: { visibility } });
      }
    });
    if (basemap?.enabled) {
      sources[BASEMAP] = { type: "raster", tiles: [basemap.url], scheme: basemap.scheme, tileSize: 256 };
      styleLayers.unshift({ id: BASEMAP, type: "raster", source: BASEMAP, layout: { visibility: basemapShown ? "visible" : "none" } });
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
    const stop = new AbortController();
    const geoTiff = layers.find(layer => layer.kind === "cog");
    if (geoTiff) drawOrthophoto(instance, geoTiff, `${location.origin}/api/runs/${encodeURIComponent(runId)}/outputs/orthophoto`, stop.signal, setOrthophoto);
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
      if ("sourceId" in event && event.sourceId === BASEMAP) setBasemapFailed(true);
      else setFailed(true);
    });
    update();
    return () => {
      stop.abort();
      const center = instance.getCenter();
      camera.current = { runId, center: [center.lng, center.lat], zoom: instance.getZoom(), bearing: instance.getBearing(), pitch: instance.getPitch() };
      map.current = null; instance.remove();
    };
  }, [runId, layers, basemap]);

  function toggle(layer: MapLayer) {
    const next = !visible[layer.name];
    setVisible(current => ({ ...current, [layer.name]: next }));
    for (const id of layer.kind === "cog" ? [layer.name, ORTHOPHOTO_DETAIL] : [layer.name]) {
      if (map.current?.getLayer(id)) map.current.setLayoutProperty(id, "visibility", next ? "visible" : "none");
    }
  }

  function toggleBasemap() {
    const next = !basemapShown;
    setBasemapShown(next);
    if (map.current?.getLayer(BASEMAP)) map.current.setLayoutProperty(BASEMAP, "visibility", next ? "visible" : "none");
  }

  const layerChoice = <fieldset disabled={!loaded}><legend>{t("map.layers")}</legend>{layers.map(layer => <Checkbox key={layer.name} id={`map-layer-${runId}-${layer.name}`} label={t(`map.layer.${layer.name}`)} checked={visible[layer.name] ?? false} onChange={() => toggle(layer)} />)}</fieldset>;
  const notices = <>
    {basemapFailed && basemap && <p role="alert">{t("basemap.failed", { url: basemap.url })}</p>}
    {failed && <div role="alert"><p>{t("map.tile_error")}</p><Button onClick={onRetry}>{t("map.retry")}</Button></div>}
    {(orthophoto === "compression" || orthophoto === "format" || orthophoto === "error") && <p role="alert">{t(`results.map.orthophoto_${orthophoto}`)}</p>}
    {orthophoto === "reading" && <p role="status">{t("results.map.orthophoto_reading")}</p>}
  </>;
  const canvas = <div ref={container} className={back ? "result-map result-map-full" : "result-map"} data-orthophoto={orthophoto ?? undefined} />;
  const attribution = basemap?.enabled && basemapShown && <p className="basemap-attribution" aria-label={t("basemap.attribution")}>{basemap.attribution}</p>;

  if (back) return <div className={coordinates ? "map-viewer" : "map-viewer map-outside"}>
    <Toolbar label={t("results.map.toolbar")}>
      <a className="button" href={back}><IconArrowLeft /> {t("results.back")}</a>
      <span className="toolbar-separator" />
      {layerChoice}
      {basemap?.enabled && <Checkbox id={`map-basemap-${runId}`} label={t("results.map.basemap")} checked={basemapShown} disabled={!loaded} onChange={toggleBasemap} />}
      <span className="toolbar-spacer" />
      <span className="map-coordinates" aria-live="off">{coordinates ?? t("results.map.outside")}</span>
    </Toolbar>
    {notices}
    {canvas}
    {attribution}
    <p className="visually-hidden">{t("map.keyboard")}</p>
  </div>;

  return <div className={coordinates ? undefined : "map-outside"}>
    {layerChoice}
    {notices}
    {canvas}
    {attribution}
    {coordinates && <p aria-live="off">{coordinates}</p>}
    <p>{t("map.keyboard")}</p>
  </div>;
}
