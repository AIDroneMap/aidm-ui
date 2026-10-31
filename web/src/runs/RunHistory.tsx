import { useEffect, useState } from "react";
import type { RunView } from "../../../shared/api-types.ts";
import type { ProjectRunsView } from "../../../shared/run-management.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Button } from "../controls/Button.tsx";
import { t } from "../i18n/translate.ts";

export function RunRows({ runs }: { runs: RunView[] }) {
  return <ul>{runs.map(run => <li key={run.id}>
    <a href={`#/runs/${run.id}`}>{run.name ?? t("run.title", { id: run.id })}</a>
    <p>{run.engineLocal ? t("run.engine_local") : t("run.engine", { name: run.engineName ?? t("run_start.not_reported") })}</p>
    <p>{t("run_start.selected_preset", { preset: run.presetName ?? (run.preset ? t(`run_start.preset.${run.preset}`) : t("run_start.not_reported")) })}</p>
    <p>{t(`run.state.${run.state}`)}</p>
    {run.state === "queued" && run.queueCount != null && <p>{t("run_manage.waiting", { count: run.queueCount })}</p>}
    <time dateTime={run.createdAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(run.createdAt))}</time>
  </li>)}</ul>;
}

export function RunHistory({ projectId, onAuthRequired }: { projectId: number; onAuthRequired(): void }) {
  const [view, setView] = useState<ProjectRunsView | null>(null), [offset, setOffset] = useState(0);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  useEffect(() => {
    let current = true, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await api<ProjectRunsView>("GET", `/api/projects/${projectId}/runs?offset=${offset}`);
        if (current) { setView(next); setFailure(null); }
      } catch (error) {
        if (!current) return;
        const problem = asApiFailure(error);
        if (problem.code === "auth.passphrase_required") { onAuthRequired(); current = false; } else setFailure(problem);
      }
      if (current) timer = setTimeout(() => void load(), 2000);
    };
    setView(null); void load();
    return () => { current = false; clearTimeout(timer); };
  }, [projectId, offset]);
  return <section aria-labelledby="run-history-title">
    <h2 id="run-history-title">{t("run_manage.history")}</h2>
    {failure && <ErrorMessage failure={failure} />}
    {view && (view.runs.length ? <RunRows runs={view.runs} /> : <p>{t("run_manage.empty")}</p>)}
    {offset > 0 && <Button className="secondary" onClick={() => setOffset(Math.max(0, offset - 50))}>{t("upload.previous")}</Button>}
    {view?.nextOffset != null && <Button className="secondary" onClick={() => setOffset(view.nextOffset!)}>{t("upload.next")}</Button>}
  </section>;
}
