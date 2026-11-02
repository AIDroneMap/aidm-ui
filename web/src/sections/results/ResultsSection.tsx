import { useEffect, useRef, useState } from "react";
import type { ProjectView, RunView } from "../../../../shared/api-types.ts";
import type { ProjectRunsView } from "../../../../shared/run-management.ts";
import { api, asApiFailure, type ApiFailure } from "../../api.ts";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { Button } from "../../controls/Button.tsx";
import { EmptyState } from "../../controls/EmptyState.tsx";
import { Notice } from "../../controls/Notice.tsx";
import { PageHeader } from "../../controls/PageHeader.tsx";
import { RUN_STATE_TONES, StatusPill } from "../../controls/StatusPill.tsx";
import { IconMap } from "../../icons/icons.tsx";
import { t } from "../../i18n/translate.ts";
import { MapViewer } from "../../map/MapView.tsx";
import { ModelViewer } from "../../model/ModelPanel.tsx";
import { projectName } from "../../pages/ProjectsPage.tsx";
import { parseRunEvent } from "../../runs.ts";
import { resultsHash, type Viewer } from "../../router.ts";
import { DeleteResults } from "./DeleteResults.tsx";
import { RunOutputs } from "./RunOutputs.tsx";
import "./results.css";

type Props = { project: ProjectView; runId?: number; viewer?: Viewer; /** Reads the project again, after a run's results changed. */ onChange(): void; onAuthRequired(): void };

// No locale is named, so the date follows the one this computer is set to.
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function runLabel(run: Pick<RunView, "id" | "name" | "sample">): string {
  return run.sample ? t("run.sample_name") : run.name || t("run.title", { id: run.id });
}

/** Every run of the project, newest first, for the names in the switcher and the latest run in the empty state. */
function useProjectRuns(projectId: number, version: string, onAuthRequired: () => void): RunView[] | null {
  const [runs, setRuns] = useState<RunView[] | null>(null);
  useEffect(() => {
    let current = true;
    (async () => {
      const all: RunView[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page: ProjectRunsView = await api<ProjectRunsView>("GET", `/api/projects/${projectId}/runs?offset=${offset}`);
        all.push(...page.runs);
        offset = page.nextOffset;
      }
      if (current) setRuns(all);
    })().catch((error: unknown) => {
      if (!current) return;
      if (asApiFailure(error).code === "auth.passphrase_required") onAuthRequired();
      // The names are a help: without them the switcher names runs by number.
      else setRuns([]);
    });
    return () => { current = false; };
  }, [projectId, version]);
  return runs;
}

/**
 * The Results section and its viewer addresses. It opens on the latest run
 * whose archive is ready, with a switcher between those runs, newest first.
 */
export function ResultsSection({ project, runId, viewer, onChange, onAuthRequired }: Props) {
  const archives = [...(project.resultArchives ?? [])].sort((a, b) => b.runId - a.runId);
  const runs = useProjectRuns(project.id, archives.map((archive) => archive.runId).join(","), onAuthRequired);
  const selected = runId ?? archives[0]?.runId;
  if (viewer !== undefined && runId !== undefined) return <ViewerScreen key={`${runId}-${viewer}`} project={project} runId={runId} viewer={viewer} onAuthRequired={onAuthRequired} />;
  return <>
    <PageHeader title={t("results.title")} subtitle={projectName(project)} />
    {selected === undefined ? <NoResults runs={runs} /> : <>
      {archives.length > 0 && <div className="results-switcher field">
        <label htmlFor="results-run">{t("results.switcher")}</label>
        <select id="results-run" value={archives.some((archive) => archive.runId === selected) ? selected : ""} onChange={(event) => { window.location.hash = resultsHash(project.id, Number(event.target.value)); }}>
          {!archives.some((archive) => archive.runId === selected) && <option value="" disabled>{t("results.switcher_other")}</option>}
          {archives.map((archive) => {
            const run = runs?.find((item) => item.id === archive.runId);
            return <option key={archive.runId} value={archive.runId}>{run ? t("results.run_option", { name: runLabel(run), date: dateFormat.format(new Date(run.createdAt)) }) : t("run.title", { id: archive.runId })}</option>;
          })}
        </select>
      </div>}
      <RunResults key={selected} project={project} runId={selected} onChange={onChange} onAuthRequired={onAuthRequired} />
    </>}
  </>;
}

function NoResults({ runs }: { runs: RunView[] | null }) {
  const latest = runs?.[0];
  return <EmptyState icon={<IconMap />} title={t("results.empty_title")} action={latest && <a className="button" href={`#/runs/${latest.id}`}>{t("results.open_latest")}</a>}>
    {latest
      ? <>{t("results.empty_latest", { name: runLabel(latest) })} <StatusPill tone={RUN_STATE_TONES[latest.state]}>{t(`run.state.${latest.state}`)}</StatusPill></>
      : t("results.empty")}
  </EmptyState>;
}

/** One run, read from the server. A run of another project opens under its own project, so the sidebar names the right one. */
function useRun(project: ProjectView, runId: number, viewer: Viewer | undefined, onAuthRequired: () => void) {
  const [run, setRun] = useState<RunView | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  useEffect(() => {
    let current = true;
    api<RunView>("GET", `/api/runs/${runId}`).then((value) => {
      if (!current) return;
      if (value.projectId !== project.id) window.location.replace(resultsHash(value.projectId, runId, viewer));
      else setRun(value);
    }, (error: unknown) => {
      if (!current) return;
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") onAuthRequired(); else setFailure(problem);
    });
    return () => { current = false; };
  }, [runId]);
  return { run, setRun, failure };
}

function RunResults({ project, runId, onChange, onAuthRequired }: { project: ProjectView; runId: number; onChange(): void; onAuthRequired(): void }) {
  const { run, setRun, failure } = useRun(project, runId, undefined, onAuthRequired);
  const [retryFailure, setRetryFailure] = useState<ApiFailure | null>(null);
  // When the results are deleted or fetched again, the switcher, the sidebar count and the Details storage come from a fresh read of the project.
  const shown = useRef<string | undefined>(undefined);
  const state = run?.results?.state;
  // While the archive is fetched, the run's events say when it is ready or failed. The stream opens with the run as it is now.
  useEffect(() => {
    if (state !== "fetching") return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.addEventListener("run", (event) => {
      const next = parseRunEvent((event as MessageEvent<string>).data);
      if (next?.id === runId) setRun(next);
    });
    return () => source.close();
  }, [runId, state]);
  useEffect(() => {
    if (state === undefined) return;
    if (shown.current !== undefined && shown.current !== state) onChange();
    shown.current = state;
  }, [state]);
  if (failure) return <ErrorMessage failure={failure} />;
  if (run === null) return <p role="status">{t("results.loading")}</p>;
  async function retry() {
    setRetryFailure(null);
    try {
      await api<unknown>("POST", `/api/runs/${runId}/results`);
      setRun(await api<RunView>("GET", `/api/runs/${runId}`));
    } catch (error) { setRetryFailure(asApiFailure(error)); }
  }
  const results = run.results;
  return <>
    <p className="results-run-facts"><a href={`#/runs/${run.id}`}>{runLabel(run)}</a></p>
    {results?.state === "ready" && <><RunOutputs run={run} /><DeleteResults run={run} onDeleted={setRun} /></>}
    {results?.state === "fetching" && <Notice>{t("run.results_fetching")}</Notice>}
    {results?.state === "failed" && <Notice tone="warn"><p>{t("results.failed")}</p><Button variant="secondary" onClick={() => void retry()}>{t("results.retry")}</Button></Notice>}
    {results?.state === "deleted" && <Notice>{t("results.deleted")}</Notice>}
    {results === undefined && <Notice>{t("results.none_for_run")}</Notice>}
    {retryFailure && <ErrorMessage failure={retryFailure} />}
  </>;
}

/** A viewer over the whole content area. Its toolbar leads back to the run's results. */
function ViewerScreen({ project, runId, viewer, onAuthRequired }: { project: ProjectView; runId: number; viewer: Viewer; onAuthRequired(): void }) {
  const { run, failure } = useRun(project, runId, viewer, onAuthRequired);
  const back = resultsHash(project.id, runId);
  const output = run?.results?.state === "ready" ? run.results.outputs.find((item) => item.name === (viewer === "map" ? "orthophoto" : "glb")) : undefined;
  return <>
    <h1 className="visually-hidden" tabIndex={-1}>{t(viewer === "map" ? "results.map.heading" : "results.model.heading", { name: run ? runLabel(run) : t("run.title", { id: runId }) })}</h1>
    {failure ? <ErrorMessage failure={failure} />
      : run === null ? <p role="status">{t("results.loading")}</p>
      : output === undefined ? <Notice><p>{t(viewer === "map" ? "results.no_map" : "results.no_model")}</p><p><a href={back}>{t("results.back")}</a></p></Notice>
      : viewer === "map" ? <MapViewer runId={String(runId)} back={back} />
      : <ModelViewer runId={String(runId)} size={output.size} back={back} />}
  </>;
}
