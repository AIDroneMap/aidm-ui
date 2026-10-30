import { lazy, Suspense, useEffect, useState } from "react";
import { t } from "../i18n/translate.ts";

const ModelView = lazy(() => import("./ModelView.tsx"));

export function ModelPanel({ runId, size }: { runId: string; size: number }) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  useEffect(() => { setOpenRun(null); }, [runId]);
  const open = openRun === runId;
  return <section>
    <button type="button" onClick={() => setOpenRun(open ? null : runId)}>{t(open ? "model.close" : "model.open")}</button>
    {open && <Suspense fallback={<p role="status">{t("model.loading")}</p>}><ModelView key={runId} runId={runId} size={size} /></Suspense>}
  </section>;
}
