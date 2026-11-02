import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ProjectView } from "../../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../../api.ts";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { Button } from "../../controls/Button.tsx";
import { Dialog } from "../../controls/Dialog.tsx";
import { PageHeader } from "../../controls/PageHeader.tsx";
import { TextField } from "../../controls/TextField.tsx";
import { formatBytes } from "../../format.ts";
import { t } from "../../i18n/translate.ts";
import { projectName } from "../../pages/ProjectsPage.tsx";

interface FormProps {
  project: ProjectView;
  name: string;
  notes: string;
  working: boolean;
  onName(value: string): void;
  onNotes(value: string): void;
  onSave(): void;
  onAskDelete(): void;
}

/** Name, notes, what the results take, and the project's deletion, as the project page had them until the Details ticket rebuilds them. */
export function DetailsForm({ project, name, notes, working, onName, onNotes, onSave, onAskDelete }: FormProps) {
  const sample = project.builtin === "sample";
  function submit(event: FormEvent) { event.preventDefault(); onSave(); }
  return <>
    {sample && <p>{t("projects.sample_help")}</p>}
    {project.resultsBytes !== undefined && <section><h2>{t("results.title")}</h2><p>{t("projects.results_total", { size: formatBytes(project.resultsBytes) })}</p>
      <ul>{project.resultArchives?.map(archive => <li key={archive.runId}><a href={`#/runs/${archive.runId}`}>{t("projects.result_run", { id: archive.runId })}</a>{t("results.size_suffix", { size: formatBytes(archive.size) })}</li>)}</ul>
    </section>}
    <form onSubmit={submit}>
      {!sample && <TextField id="project-name" label={t("projects.name")} value={name} onChange={event => onName(event.target.value)} required maxLength={200} />}
      <div className="field"><label htmlFor="project-notes">{t("projects.notes")}</label><textarea id="project-notes" value={notes} onChange={event => onNotes(event.target.value)} maxLength={100000} /></div>
      <Button type="submit" disabled={working}>{t("projects.save")}</Button>
    </form>
    <p><Button className="secondary" disabled={working} onClick={onAskDelete}>{t("projects.delete")}</Button></p>
  </>;
}

export function DeleteConfirmation({ working, onKeep, onDelete }: { working: boolean; onKeep(): void; onDelete(): void }) {
  return <>
    <h2>{t("projects.delete_title")}</h2><p>{t("projects.delete_explain")}</p>
    <Button className="secondary" disabled={working} onClick={onKeep}>{t("projects.keep")}</Button>{" "}
    <Button disabled={working} onClick={onDelete}>{t("projects.delete_confirm")}</Button>
  </>;
}

/** The Details section. The draft of name and notes is the operator's: a fresh read of the project does not overwrite it. */
export function DetailsSection({ project, onChange, onAuthRequired }: { project: ProjectView; onChange(): void; onAuthRequired(): void }) {
  const [name, setName] = useState(project.name);
  const [notes, setNotes] = useState(project.notes);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [working, setWorking] = useState(false);
  const [asking, setAsking] = useState(false);
  const [saved, setSaved] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (asking) dialog.current?.showModal(); }, [asking]);
  function showError(error: unknown) {
    const problem = asApiFailure(error);
    if (problem.code === "auth.passphrase_required") onAuthRequired(); else setFailure(problem);
  }
  async function save() {
    if (working) return;
    setWorking(true); setFailure(null); setSaved(false);
    try {
      const result = await api<ProjectView>("PUT", `/api/projects/${project.id}`, { name, notes });
      setName(result.name); setNotes(result.notes); setSaved(true);
      onChange();
    } catch (error) { showError(error); } finally { setWorking(false); }
  }
  async function remove() {
    if (working) return;
    setWorking(true); setFailure(null);
    try { await api<void>("DELETE", `/api/projects/${project.id}`); window.location.hash = "#/"; }
    catch (error) { setAsking(false); showError(error); } finally { setWorking(false); }
  }
  return <>
    <PageHeader title={t("details.title")} subtitle={projectName(project)} />
    {failure && <ErrorMessage failure={failure} />}
    <DetailsForm project={project} name={name} notes={notes} working={working} onName={setName} onNotes={setNotes} onSave={() => void save()} onAskDelete={() => setAsking(true)} />
    <p role="status">{saved ? t("projects.saved") : null}</p>
    {asking && <Dialog ref={dialog} label={t("projects.delete_title")} onCancel={event => { event.preventDefault(); if (!working) setAsking(false); }}>
      <DeleteConfirmation working={working} onKeep={() => setAsking(false)} onDelete={() => void remove()} />
    </Dialog>}
  </>;
}
