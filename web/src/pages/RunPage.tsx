import { useEffect } from "react";
import type { RunView } from "../../../shared/api-types.ts";
import { api } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { RunProgress } from "../components/RunProgress.tsx";
import { t } from "../i18n/translate.ts";
import { ModelPanel } from "../model/ModelPanel.tsx";
import { useRun } from "../useRun.ts";
import { MapPanel } from "../map/MapView.tsx";

export function RunPage({ runId, onAuthRequired }: { runId: string; onAuthRequired: () => void }) {
  const { run, setRun, log, stage, restartedAtLine, connectionLost, cancelling, failure, setFailure, fail, cancel } = useRun(onAuthRequired);
  useEffect(() => {
    let current = true;
    api<RunView>("GET", `/api/runs/${runId}`).then(
      value => { if (current) setRun(value); },
      error => { if (current) setFailure(fail(error)); },
    );
    return () => { current = false; };
  }, [runId]);
  const model = run?.id === Number(runId) && run.results?.state === "ready" ? run.results.outputs.find(output => output.name === "glb") : undefined;
  return <>
    {run && <a href={`#/projects/${run.projectId}`}>{t("run.back_to_project")}</a>}
    <h1>{t("run.title", { id: runId })}</h1>
    {run ? <RunProgress run={run} stage={stage} lines={log.lines} lineCount={log.count} restartedAtLine={restartedAtLine} connectionLost={connectionLost} cancelling={cancelling} failure={failure} onCancel={() => void cancel()} />
      : failure ? <ErrorMessage failure={failure} /> : <p>{t("run.loading")}</p>}
    {run?.id === Number(runId) && run.results?.state === "ready" && <MapPanel key={runId} runId={runId} />}
    {model && <ModelPanel key={runId} runId={runId} size={model.size} />}
  </>;
}
