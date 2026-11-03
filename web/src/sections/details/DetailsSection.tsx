import { useEffect, useState, type FormEvent } from "react";
import type { FolderImportView, ProjectView, UploadedFilesView } from "../../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../../api.ts";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { Button } from "../../controls/Button.tsx";
import { PageHeader } from "../../controls/PageHeader.tsx";
import { Table } from "../../controls/Table.tsx";
import { TextAreaField } from "../../controls/TextAreaField.tsx";
import { TextField } from "../../controls/TextField.tsx";
import { formatBytes } from "../../format.ts";
import { t } from "../../i18n/translate.ts";
import { projectName } from "../../pages/ProjectsPage.tsx";
import { DeleteConfirmation, projectArchiveBytes, type ProjectStorage } from "./DeleteConfirmation.tsx";
import "./DetailsSection.css";

interface FormProps {
  project: ProjectView;
  name: string;
  notes: string;
  working: boolean;
  storage?: ProjectStorage | null;
  onName(value: string): void;
  onNotes(value: string): void;
  onSave(): void;
  onAskDelete(): void;
}

/** The form and storage describe only this project's files on this computer. */
export function DetailsForm({ project, name, notes, working, storage, onName, onNotes, onSave, onAskDelete }: FormProps) {
  const sample = project.builtin === "sample";
  const archiveBytes = projectArchiveBytes(project);
  const size = (bytes: number | null) => bytes === null ? t("details.storage_unknown") : formatBytes(bytes);
  const files = (entry: ProjectStorage["photos"] | undefined) => entry ? t("details.file_size", { count: entry.count, size: formatBytes(entry.bytes) }) : t("details.loading_storage");
  const total = storage && archiveBytes !== null ? storage.photos.bytes + storage.other.bytes + archiveBytes : null;
  const folder = storage?.folder;
  function submit(event: FormEvent) { event.preventDefault(); onSave(); }
  return <>
    {sample && <p>{t("projects.sample_help")}</p>}
    {sample
      ? <dl className="details-form">
          <dt>{t("projects.name")}</dt><dd>{projectName(project)}</dd>
          <dt>{t("projects.notes")}</dt><dd>{notes}</dd>
        </dl>
      : <form className="details-form" onSubmit={submit}>
          <TextField id="project-name" label={t("projects.name")} value={name} onChange={event => onName(event.target.value)} required maxLength={200} />
          <TextAreaField id="project-notes" label={t("projects.notes")} value={notes} onChange={event => onNotes(event.target.value)} maxLength={100000} />
          <Button type="submit" disabled={working}>{t("projects.save")}</Button>
        </form>
    }
    <Table className="details-storage" label={t("details.storage")}>
      <tbody>
        <tr><th scope="row">{t("details.uploaded_photos")}</th><td>{files(storage?.photos)}</td></tr>
        {storage && storage.other.count > 0 && <tr><th scope="row">{t("details.other_files")}</th><td>{files(storage.other)}</td></tr>}
        <tr><th scope="row">{t("details.imported_folder")}</th><td>{!storage ? t("details.loading_storage") : folder && folder.state !== "none" ? <>{folder.path ?? t("details.folder_path_unavailable")}<p>{t("details.folder_preserved")}</p></> : t("details.no_folder")}</td></tr>
        {project.resultArchives?.map(archive => <tr key={archive.runId}><th scope="row"><a href={`#/runs/${archive.runId}`}>{t("projects.result_run", { id: archive.runId })}</a></th><td>{formatBytes(archive.size)}</td></tr>)}
        <tr><th scope="row">{t("details.storage_total")}</th><td>{!storage ? t("details.loading_storage") : size(total)}</td></tr>
      </tbody>
    </Table>
    <section className="details-danger" aria-labelledby="details-danger-title">
      <h2 id="details-danger-title">{t("details.danger_title")}</h2>
      <p>{t("details.delete_explain")}</p>
      <Button variant="secondary" disabled={working || !storage || archiveBytes === null} onClick={onAskDelete}>{t("projects.delete")}</Button>
    </section>
  </>;
}

async function loadStorage(project: ProjectView, current: () => boolean): Promise<ProjectStorage | null> {
  const empty = { photos: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 }, folder: null };
  if (project.builtin === "sample") return empty;
  const folder = await api<FolderImportView>("GET", `/api/projects/${project.id}/import?limit=1`);
  const files = new Map<string, { size: number; photo: boolean }>();
  let offset: number | null = 0;
  while (offset !== null) {
    if (!current()) return null;
    const page: UploadedFilesView = await api<UploadedFilesView>("GET", `/api/projects/${project.id}/photos?offset=${offset}&limit=100`);
    for (const file of page.files) {
      const previous = files.get(file.sha256);
      files.set(file.sha256, { size: file.size, photo: file.kind === "photo" || previous?.photo === true });
    }
    offset = page.nextOffset;
  }
  const storage: ProjectStorage = { ...empty, folder: { state: folder.state, path: folder.path } };
  for (const file of files.values()) {
    const group = file.photo ? storage.photos : storage.other;
    group.count++; group.bytes += file.size;
  }
  return storage;
}

/** Fresh project reads do not replace the operator's unsaved name or notes. */
export function DetailsSection({ project, onChange, onAuthRequired }: { project: ProjectView; onChange(): void; onAuthRequired(): void }) {
  const [name, setName] = useState(project.name), [notes, setNotes] = useState(project.notes);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [storageFailure, setStorageFailure] = useState<ApiFailure | null>(null);
  const [storage, setStorage] = useState<ProjectStorage | null>(null);
  const [read, setRead] = useState(0);
  const [working, setWorking] = useState(false), [asking, setAsking] = useState(false), [saved, setSaved] = useState(false);
  useEffect(() => {
    let current = true;
    setStorage(null); setStorageFailure(null);
    loadStorage(project, () => current).then(value => { if (current) setStorage(value); }, error => {
      if (!current) return;
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") onAuthRequired(); else setStorageFailure(problem);
    });
    return () => { current = false; };
  }, [project.id, project.builtin, project.lastChange, read]);
  function showError(error: unknown) {
    const problem = asApiFailure(error);
    if (problem.code === "auth.passphrase_required") onAuthRequired(); else setFailure(problem);
  }
  async function save() {
    if (working) return;
    setWorking(true); setFailure(null); setSaved(false);
    try {
      const result = await api<ProjectView>("PUT", `/api/projects/${project.id}`, { name, notes });
      setName(result.name); setNotes(result.notes); setSaved(true); onChange();
    } catch (error) { showError(error); } finally { setWorking(false); }
  }
  async function remove() {
    if (working || !storage || projectArchiveBytes(project) === null) return;
    setWorking(true); setFailure(null);
    try { await api<void>("DELETE", `/api/projects/${project.id}`); window.location.hash = "#/"; }
    catch (error) { setAsking(false); showError(error); } finally { setWorking(false); }
  }
  return <>
    <PageHeader title={t("details.title")} subtitle={projectName(project)} />
    {failure && <ErrorMessage failure={failure} />}
    {storageFailure && <div><ErrorMessage failure={storageFailure} /><Button variant="secondary" data-storage-retry onClick={() => setRead(value => value + 1)}>{t("details.retry_storage")}</Button></div>}
    <p role="status">{saved ? t("projects.saved") : null}</p>
    <DetailsForm project={project} name={name} notes={notes} working={working} storage={storage} onName={setName} onNotes={setNotes} onSave={() => void save()} onAskDelete={() => setAsking(true)} />
    {storage && <DeleteConfirmation target={{ kind: "project", project, storage }} open={asking} busy={working} onCancel={() => setAsking(false)} onConfirm={() => void remove()} />}
  </>;
}
