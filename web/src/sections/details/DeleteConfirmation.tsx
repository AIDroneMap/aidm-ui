import type { FolderImportView, ProjectView, RunView } from "../../../../shared/api-types.ts";
import { ConfirmDialog } from "../../controls/ConfirmDialog.tsx";
import { formatBytes } from "../../format.ts";
import { t } from "../../i18n/translate.ts";
import "./DeleteConfirmation.css";

export interface ProjectStorage {
  photos: { count: number; bytes: number };
  other: { count: number; bytes: number };
  folder: Pick<FolderImportView, "state" | "path"> | null;
}

export type DeletionTarget =
  | { kind: "project"; project: ProjectView; storage: ProjectStorage }
  | { kind: "run" | "results"; run: RunView };

type Props = {
  target: DeletionTarget;
  open: boolean;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
};

/** Bytes of local archives only. The API does not report the space used on an engine. */
export function projectArchiveBytes(project: ProjectView): number | null {
  return project.resultsBytes ?? (project.resultArchives?.reduce((sum, archive) => sum + archive.size, 0) ?? null);
}

/** The three deletion questions share their item lists, size labels and safe default focus. */
export function DeleteConfirmation({ target, ...dialog }: Props) {
  const knownSize = (bytes: number | null) => bytes === null ? t("danger.size_unknown") : formatBytes(bytes);
  if (target.kind === "project") {
    const { project, storage } = target;
    const archives = projectArchiveBytes(project);
    const size = knownSize(archives === null ? null : storage.photos.bytes + storage.other.bytes + archives);
    const folder = storage.folder;
    return <ConfirmDialog {...dialog} danger title={t("danger.project_title", { name: project.builtin === "sample" ? t("projects.sample_name") : project.name })}
      confirmLabel={t("danger.project_confirm", { size })} cancelLabel={t("danger.project_keep")}><div className="details-delete-content">
      <ul>
        <li>{t("danger.photos", { count: storage.photos.count, size: formatBytes(storage.photos.bytes) })}</li>
        {storage.other.count > 0 && <li>{t("danger.other_files", { count: storage.other.count, size: formatBytes(storage.other.bytes) })}</li>}
        <li>{t("danger.archives", { count: project.resultArchives?.length ?? 0, size: knownSize(archives) })}</li>
        <li>{t("danger.project_runs", { count: project.runCount })}</li>
      </ul>
      <p>{t("danger.local_sizes")}</p>
      {folder && folder.state !== "none" && <p>{folder.path ? t("danger.folder_stays", { path: folder.path }) : t("danger.folder_stays_hidden")}</p>}
      {project.builtin === "sample" && <p>{t("danger.sample_stays")}</p>}
    </div></ConfirmDialog>;
  }
  const { run, kind } = target;
  const archiveSize = run.results?.state === "ready" ? run.results.archiveSize : 0;
  const size = knownSize(archiveSize);
  const name = run.sample ? t("run.sample_name") : run.name || t("danger.run_name", { id: run.id });
  return <ConfirmDialog {...dialog} danger title={t(`danger.${kind}_title`, { name })}
    confirmLabel={t(`danger.${kind}_confirm`, { size })} cancelLabel={t(`danger.${kind}_keep`)}><div className="details-delete-content">
    <ul>
      <li>{t("danger.archive", { size })}</li>
      {kind === "run" && <li>{t("danger.run_records")}</li>}
      {kind === "run" && run.engineId !== null && <li>{t("danger.engine_run", { name: run.engineLocal ? t("danger.local_engine") : run.engineName ?? t("danger.selected_engine") })}</li>}
    </ul>
    <p>{t("danger.local_sizes")}</p>
    <p>{t(kind === "results" ? "danger.results_stay" : "danger.run_stay")}</p>
  </div></ConfirmDialog>;
}
