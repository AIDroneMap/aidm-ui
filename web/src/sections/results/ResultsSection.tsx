import { useEffect, useState } from "react";
import type { ProjectView, RunView } from "../../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../../api.ts";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { Results } from "../../components/Results.tsx";
import { EmptyState } from "../../controls/EmptyState.tsx";
import { PageHeader } from "../../controls/PageHeader.tsx";
import { formatBytes } from "../../format.ts";
import { IconMap } from "../../icons/icons.tsx";
import { t } from "../../i18n/translate.ts";
import { MapPanel } from "../../map/MapView.tsx";
import { ModelPanel } from "../../model/ModelPanel.tsx";
import { projectName } from "../../pages/ProjectsPage.tsx";
import { resultsHash, sectionHash, type Viewer } from "../../router.ts";

type Props = { project: ProjectView; runId?: number; viewer?: Viewer; onAuthRequired(): void };

/**
 * The Results section and its viewer addresses. Until the Results ticket
 * rebuilds them, the list names each run with an archive, a run's address
 * shows its downloads, and the viewers are the panels the run page has.
 */
export function ResultsSection({ project, runId, viewer, onAuthRequired }: Props) {
  return <>
    <PageHeader title={t("results.title")} subtitle={projectName(project)} />
    {runId === undefined ? <ResultList project={project} /> : <RunResults key={runId} project={project} runId={runId} viewer={viewer} onAuthRequired={onAuthRequired} />}
  </>;
}

function ResultList({ project }: { project: ProjectView }) {
  const archives = project.resultArchives ?? [];
  if (archives.length === 0) return <EmptyState icon={<IconMap />}>{t("results.empty")}</EmptyState>;
  return <ul>{[...archives].reverse().map((archive) => <li key={archive.runId}>
    <a href={resultsHash(project.id, archive.runId)}>{t("projects.result_run", { id: archive.runId })}</a>{t("results.size_suffix", { size: formatBytes(archive.size) })}
  </li>)}</ul>;
}

function RunResults({ project, runId, viewer, onAuthRequired }: Required<Pick<Props, "project" | "runId">> & Pick<Props, "viewer" | "onAuthRequired">) {
  const [run, setRun] = useState<RunView | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  useEffect(() => {
    let current = true;
    api<RunView>("GET", `/api/runs/${runId}`).then((value) => {
      if (!current) return;
      // A run of another project opens under its own project, so the sidebar names the right one.
      if (value.projectId !== project.id) window.location.replace(resultsHash(value.projectId, runId, viewer));
      else setRun(value);
    }, (error: unknown) => {
      if (!current) return;
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") onAuthRequired(); else setFailure(problem);
    });
    return () => { current = false; };
  }, [runId]);
  if (failure) return <ErrorMessage failure={failure} />;
  if (run === null) return <p>{t("results.loading")}</p>;
  const ready = run.results?.state === "ready";
  const model = ready ? run.results?.outputs.find((output) => output.name === "glb") : undefined;
  return <>
    <p><a href={viewer ? resultsHash(project.id, runId) : sectionHash(project.id, "results")}>{t("results.back")}</a></p>
    {viewer === "map" ? <MapPanel runId={String(runId)} />
      : viewer === "model" ? (model ? <ModelPanel runId={String(runId)} size={model.size} /> : <p>{t("results.no_model")}</p>)
      : <>
        <Results run={run} onChange={setRun} />
        {ready && <p className="actions">
          <a className="button secondary" href={resultsHash(project.id, runId, "map")}>{t("results.open_map")}</a>
          {model && <a className="button secondary" href={resultsHash(project.id, runId, "model")}>{t("results.open_model")}</a>}
        </p>}
      </>}
  </>;
}
