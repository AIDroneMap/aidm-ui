import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { isBasemapSettings, type BasemapSettings } from "../../../shared/basemap.ts";
import type { RunMapView } from "../../../shared/map.ts";
import { t } from "../i18n/translate.ts";

const MapCanvas = lazy(() => import("./MapCanvas.tsx"));

class MapErrorBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div role="alert"><p>{t("map.error")}</p><button onClick={this.props.onRetry}>{t("map.retry")}</button></div>;
    return this.props.children;
  }
}

export function sameOriginRequest(url: string, origin: string): { url: string } {
  const parsed = new URL(url, origin);
  if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) throw new Error("Blocked map request");
  return { url: parsed.href };
}

/** The run's map layers and the operator's basemap, read while `open` is true. A new attempt reads them again. */
function useMapData(runId: string, open: boolean, attempt: number) {
  const [view, setView] = useState<RunMapView | null>(null);
  const [failed, setFailed] = useState(false);
  const [basemap, setBasemap] = useState<BasemapSettings | null>(null);
  const [basemapFailed, setBasemapFailed] = useState(false);

  useEffect(() => {
    setView(null);
    setFailed(false);
  }, [runId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setView(null);
    setFailed(false);
    setBasemap(null); setBasemapFailed(false);
    fetch("/api/settings/basemap", { credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      .then(response => { if (!response.ok) throw new Error(); return response.json() as Promise<unknown>; })
      .then(value => { if (!isBasemapSettings(value)) throw new Error(); if (!controller.signal.aborted) setBasemap(value.enabled ? value : null); })
      .catch(() => { if (!controller.signal.aborted) setBasemapFailed(true); });
    fetch(`/api/runs/${encodeURIComponent(runId)}/map`, { credentials: "same-origin", signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(); return response.json() as Promise<RunMapView>; })
      .then(result => { if (!controller.signal.aborted) setView(result); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [runId, open, attempt]);

  return { view, failed, basemap, basemapFailed };
}

function MapStates({ runId, back, open }: { runId: string; back?: string; open: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [mapAttempt, setMapAttempt] = useState(0);
  const { view, failed, basemap, basemapFailed } = useMapData(runId, open, attempt);
  const retry = () => setAttempt(value => value + 1);
  return <>
    {open && !view && !failed && <p role="status">{t("map.loading")}</p>}
    {basemapFailed && <div role="alert"><p>{t("basemap.settings_failed")}</p><button onClick={retry}>{t("basemap.retry")}</button></div>}
    {failed && <div role="alert"><p>{t("map.error")}</p><button onClick={retry}>{t("map.retry")}</button></div>}
    {view?.state === "unavailable" && <p role="status">{t("map.unavailable")}</p>}
    {view?.state === "ready" && view.layers.length > 0 && <MapErrorBoundary key={`${runId}-${mapAttempt}`} onRetry={() => setMapAttempt(value => value + 1)}><Suspense fallback={<p role="status">{t("map.loading")}</p>}><MapCanvas runId={runId} layers={view.layers} basemap={basemap} back={back} onRetry={() => setMapAttempt(value => value + 1)} /></Suspense></MapErrorBoundary>}
    {view?.state === "ready" && view.layers.length === 0 && <p role="status">{t("map.unavailable")}</p>}
  </>;
}

/** The map of a run behind an open button, as the run page shows it. */
export function MapPanel({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [runId]);
  return <section aria-label={t("map.title")}>
    {!open && <button onClick={() => setOpen(true)}>{t("map.open")}</button>}
    <MapStates runId={runId} open={open} />
  </section>;
}

/** The map of a run on its own address, over the whole content area, with one toolbar that leads back to `back`. */
export function MapViewer({ runId, back }: { runId: string; back: string }) {
  return <section aria-label={t("map.title")} className="map-viewer-section">
    <MapStates runId={runId} back={back} open />
  </section>;
}
