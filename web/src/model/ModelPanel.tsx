import { lazy, Suspense, useEffect, useState } from "react";
import { Button } from "../controls/Button.tsx";
import { t } from "../i18n/translate.ts";
import "./model.css";

const ModelView = lazy(() => import("./ModelView.tsx"));

export function ModelPanel({ runId, size }: { runId: string; size: number }) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  useEffect(() => { setOpenRun(null); }, [runId]);
  const open = openRun === runId;
  return <section>
    <Button onClick={() => setOpenRun(open ? null : runId)}>{t(open ? "model.close" : "model.open")}</Button>
    {open && <Suspense fallback={<p role="status">{t("model.loading")}</p>}><ModelView key={runId} runId={runId} size={size} /></Suspense>}
  </section>;
}

/** The 3D model of a run on its own address, over the whole content area, with one toolbar that leads back to `back`. */
export function ModelViewer({ runId, size, back }: { runId: string; size: number; back: string }) {
  return <section aria-label={t("results.model.title")} className="model-viewer-section">
    <Suspense fallback={<p role="status">{t("model.loading")}</p>}><ModelView key={runId} runId={runId} size={size} back={back} /></Suspense>
  </section>;
}
