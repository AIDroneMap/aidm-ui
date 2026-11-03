import { useEffect, useState } from "react";
import type { RunView } from "../../../shared/api-types.ts";
import { api } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { RunProgress } from "../components/RunProgress.tsx";
import { t } from "../i18n/translate.ts";
import { ModelPanel } from "../model/ModelPanel.tsx";
import { useRun } from "../useRun.ts";
import { RunActions } from "../runs/RunActions.tsx";
import { RunStart } from "../run-start/RunStart.tsx";
import { MapPanel } from "../map/MapView.tsx";
import { sectionHash } from "../router.ts";

export function RunPage({ runId, onProject, onAuthRequired }: { runId: string; /** Told the run's project once the run has loaded, so the sidebar shows that project. */ onProject?: (projectId: number) => void; onAuthRequired: () => void }) {
  const { run, setRun, log, restartedAtLine, connectionLost, cancelling, failure, setFailure, fail, cancel } = useRun(onAuthRequired);
  useEffect(() => {
    let current = true;
    api<RunView>("GET", `/api/runs/${runId}`).then(
      value => { if (current) { setRun(value); onProject?.(value.projectId); } },
      error => { if (current) setFailure(fail(error)); },
    );
    return () => { current = false; };
  }, [runId]);
  const [again, setAgain] = useState<string | null>(null);
  const loaded = run?.id === Number(runId) ? run : null;
  const ready = loaded?.results?.state === "ready";
  const model = ready ? loaded.results!.outputs.find(output => output.name === "glb") : undefined;
  if (!loaded) return <><h1>{t("run.title", { id: runId })}</h1>{failure ? <ErrorMessage failure={failure} /> : <p>{t("run.loading")}</p>}</>;
  return <>
    <RunProgress
      run={loaded}
      lines={log.lines}
      lineCount={log.count}
      restartedAtLine={restartedAtLine}
      connectionLost={connectionLost}
      cancelling={cancelling}
      failure={failure}
      onCancel={() => void cancel()}
      level={1}
      back={<a href={sectionHash(loaded.projectId, "runs")}>{t("run.back_to_project")}</a>}
      actions={<RunActions key={runId} run={loaded} onAuthRequired={onAuthRequired} onAgain={() => setAgain(runId)} />}
      viewers={ready && <>
        <MapPanel key={`map-${runId}`} runId={runId} />
        {model && <ModelPanel key={`model-${runId}`} runId={runId} size={model.size} />}
      </>}
    />
    {again === runId && <RunStart key={`again-${runId}`} projectId={loaded.projectId} sourceRunId={loaded.id} onAuthRequired={onAuthRequired} />}
  </>;
}
