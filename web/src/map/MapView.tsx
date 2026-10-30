import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
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

export function MapPanel({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<RunMapView | null>(null);
  const [failed, setFailed] = useState(false);
  const [mapAttempt, setMapAttempt] = useState(0);

  useEffect(() => {
    setOpen(false);
    setView(null);
    setFailed(false);
  }, [runId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setView(null);
    setFailed(false);
    fetch(`/api/runs/${encodeURIComponent(runId)}/map`, { credentials: "same-origin", signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(); return response.json() as Promise<RunMapView>; })
      .then(result => { if (!controller.signal.aborted) setView(result); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [runId, open, attempt]);

  return <section aria-label={t("map.title")}>
    {!open && <button onClick={() => setOpen(true)}>{t("map.open")}</button>}
    {open && !view && !failed && <p role="status">{t("map.loading")}</p>}
    {failed && <div role="alert"><p>{t("map.error")}</p><button onClick={() => setAttempt(value => value + 1)}>{t("map.retry")}</button></div>}
    {view?.state === "unavailable" && <p role="status">{t("map.unavailable")}</p>}
    {view?.state === "ready" && view.layers.length > 0 && <MapErrorBoundary key={`${runId}-${mapAttempt}`} onRetry={() => setMapAttempt(value => value + 1)}><Suspense fallback={<p role="status">{t("map.loading")}</p>}><MapCanvas runId={runId} layers={view.layers} onRetry={() => setMapAttempt(value => value + 1)} /></Suspense></MapErrorBoundary>}
    {view?.state === "ready" && view.layers.length === 0 && <p role="status">{t("map.unavailable")}</p>}
  </section>;
}
