import { useEffect, useId, useRef, useState } from "react";
import { FINISHED_RUN_STATES, type ProjectView, type RunView } from "../../../../shared/api-types.ts";
import type { ProjectRunsView } from "../../../../shared/run-management.ts";
import { api, asApiFailure, type ApiFailure } from "../../api.ts";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { EmptyState } from "../../controls/EmptyState.tsx";
import { IconEllipsis, IconPlay } from "../../icons/icons.tsx";
import { Button } from "../../controls/Button.tsx";
import { Popover } from "../../controls/Popover.tsx";
import { Progress } from "../../controls/Progress.tsx";
import { RUN_STATE_TONES, StatusPill } from "../../controls/StatusPill.tsx";
import { Table } from "../../controls/Table.tsx";
import { formatBytes, formatDuration } from "../../format.ts";
import { t } from "../../i18n/translate.ts";
import { sectionHash } from "../../router.ts";
import { DeleteConfirmation } from "../details/DeleteConfirmation.tsx";

function runDisplayName(run: RunView): string {
  if (run.sample) return t("run.sample_name");
  return run.name || t("run.title", { id: run.id });
}

function isActive(run: RunView): boolean {
  return !FINISHED_RUN_STATES.includes(run.state) || run.step === "results";
}

function closeMenu(button: HTMLButtonElement) {
  button.closest<HTMLElement>("[popover]")?.hidePopover();
}

type TableRowProps = {
  run: RunView;
  busy: boolean;
  onDelete: (run: RunView) => void;
  onAgain: (run: RunView) => void;
  onAuthRequired: () => void;
};

function RunTableRow({ run, busy, onDelete, onAgain, onAuthRequired }: TableRowProps) {
  const progressId = useId();
  const [retrying, setRetrying] = useState(false);
  const retryPending = useRef(false);
  const [retryFailure, setRetryFailure] = useState<ApiFailure | null>(null);
  const active = isActive(run);
  const name = runDisplayName(run);
  const engineLabel = run.engineLocal ? t("run.engine_local") : (run.engineName ?? t("runs.not_reported"));
  const presetLabel = run.presetName || (run.preset ? t(`run_start.preset.${run.preset}`) : t("runs.not_reported"));
  const durationLabel = run.processingTime != null && run.processingTime >= 0 ? formatDuration(run.processingTime / 1000) : t("runs.not_reported");
  const archiveSize = run.results?.archiveSize;
  const sizeLabel = archiveSize != null ? formatBytes(archiveSize) : t("runs.not_reported");
  const canRetry = run.state === "failed" && !run.sample;
  const canRunAgain = FINISHED_RUN_STATES.includes(run.state) && !run.sample;
  const rowBusy = busy || retrying || run.state === "created" || run.state === "uploading" || run.step === "results";

  async function handleRetry() {
    if (rowBusy || retryPending.current) return;
    retryPending.current = true;
    setRetrying(true);
    setRetryFailure(null);
    try {
      const next = await api<{ id: number }>("POST", `/api/runs/${run.id}/retry`);
      location.hash = `#/runs/${next.id}`;
    } catch (error) {
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") onAuthRequired(); else setRetryFailure(problem);
    } finally {
      retryPending.current = false;
      setRetrying(false);
    }
  }

  return (
    <tr className={active ? "run-row run-row-active" : "run-row"}>
      <td><a href={`#/runs/${run.id}`}>{name}</a></td>
      <td>{presetLabel}</td>
      <td>{engineLabel}</td>
      <td>
        <StatusPill tone={RUN_STATE_TONES[run.state]}>{t(`run.state.${run.state}`)}</StatusPill>
        {active && (
          <Progress
            id={progressId}
            label={t("runs.progress")}
            hideLabel
            className="run-progress"
            {...(run.progress != null ? { value: run.progress, max: 100 } : {})}
          />
        )}
      </td>
      <td><time dateTime={run.createdAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(run.createdAt))}</time></td>
      <td>{durationLabel}</td>
      <td>{sizeLabel}</td>
      <td>
        <a href={`#/runs/${run.id}`}>{t("runs.open")}</a>{" "}
        <Popover
          trigger={<><IconEllipsis /><span className="visually-hidden">{t("runs.more_actions", { name })}</span></>}
          label={t("runs.more_actions", { name })}
        >
          {canRetry && (
            <Button variant="secondary" disabled={rowBusy} onClick={event => { closeMenu(event.currentTarget); void handleRetry(); }}>{t("run_manage.retry")}</Button>
          )}
          {canRunAgain && (
            <Button variant="secondary" disabled={rowBusy} onClick={event => { closeMenu(event.currentTarget); onAgain(run); }}>{t("run_manage.again")}</Button>
          )}
          <Button variant="secondary" disabled={rowBusy} onClick={event => { closeMenu(event.currentTarget); onDelete(run); }}>{t("run_manage.delete")}</Button>
        </Popover>
        {retryFailure && <ErrorMessage failure={retryFailure} />}
      </td>
    </tr>
  );
}

type EmptyStateProps = { project: ProjectView };

function RunsEmptyState({ project }: EmptyStateProps) {
  const needsPhotos = project.photoCount === 0;
  return (
    <EmptyState
      icon={<IconPlay />}
      title={t("runs.empty_title")}
      action={<a className="button" href={sectionHash(project.id, needsPhotos ? "photos" : "settings")}>{t(needsPhotos ? "runs.photos" : "runs.settings")}</a>}
    >
      {t(needsPhotos ? "runs.no_photos" : "runs.no_runs")}
    </EmptyState>
  );
}

type Props = {
  project: ProjectView;
  onAgain: (run: RunView) => void;
  onAuthRequired: () => void;
};

export function RunsTable({ project, onAgain, onAuthRequired }: Props) {
  const [view, setView] = useState<ProjectRunsView | null>(null);
  const [offset, setOffset] = useState(0);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [deleting, setDeleting] = useState<RunView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deletePending = useRef(false);
  const [deleteFailure, setDeleteFailure] = useState<ApiFailure | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await api<ProjectRunsView>("GET", `/api/projects/${project.id}/runs?offset=${offset}`);
        if (current) { setView(next); setFailure(null); }
      } catch (error) {
        if (!current) return;
        const problem = asApiFailure(error);
        if (problem.code === "auth.passphrase_required") { onAuthRequired(); current = false; } else setFailure(problem);
      }
      if (current) timer = setTimeout(() => void load(), 2000);
    };
    setView(null);
    void load();
    return () => { current = false; clearTimeout(timer); };
  }, [project.id, offset, revision]);

  async function handleDeleteConfirm() {
    if (!deleting || deletePending.current) return;
    deletePending.current = true;
    setDeleteBusy(true);
    setDeleteFailure(null);
    try {
      await api("DELETE", `/api/runs/${deleting.id}`);
      setDeleting(null);
      if (view?.runs.length === 1 && offset > 0) setOffset(Math.max(0, offset - 50));
      setRevision(value => value + 1);
    } catch (error) {
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") onAuthRequired();
      else { setDeleteFailure(problem); setDeleting(null); }
    } finally {
      deletePending.current = false;
      setDeleteBusy(false);
    }
  }

  const runs = view?.runs ?? [];

  return (
    <section className="runs-section" aria-labelledby="run-history-title">
      <h2 id="run-history-title">{t("run_manage.history")}</h2>
      {failure && <ErrorMessage failure={failure} />}
      {deleteFailure && <p role="alert" className="error">{t("runs.delete_failed")}</p>}
      {!view && !failure && <p role="status">{t("runs.loading")}</p>}
      {view && runs.length === 0 ? (
        <RunsEmptyState project={project} />
      ) : (
        view && (
          <div className="runs-table-scroll" role="region" aria-label={t("runs.title")} tabIndex={0}>
            <Table className="runs-table" label={t("runs.title")} dense>
              <thead>
                <tr>
                  <th scope="col">{t("runs.col.name")}</th>
                  <th scope="col">{t("runs.col.preset")}</th>
                  <th scope="col">{t("runs.col.engine")}</th>
                  <th scope="col">{t("runs.col.state")}</th>
                  <th scope="col">{t("runs.col.started")}</th>
                  <th scope="col">{t("runs.col.duration")}</th>
                  <th scope="col">{t("runs.col.size")}</th>
                  <th scope="col">{t("runs.col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(run => (
                  <RunTableRow
                    key={run.id}
                    run={run}
                    busy={deleteBusy}
                    onDelete={run => { setDeleteFailure(null); setDeleting(run); }}
                    onAgain={onAgain}
                    onAuthRequired={onAuthRequired}
                  />
                ))}
              </tbody>
            </Table>
          </div>
        )
      )}
      {offset > 0 && (
        <Button variant="secondary" onClick={() => setOffset(Math.max(0, offset - 50))}>
          {t("upload.previous")}
        </Button>
      )}
      {view?.nextOffset != null && (
        <Button variant="secondary" onClick={() => setOffset(view.nextOffset!)}>
          {t("upload.next")}
        </Button>
      )}
      {deleting && <DeleteConfirmation
        target={{ kind: "run", run: deleting }}
        open
        busy={deleteBusy}
        onConfirm={handleDeleteConfirm}
        onCancel={() => { setDeleting(null); setDeleteFailure(null); }}
      />}
    </section>
  );
}
