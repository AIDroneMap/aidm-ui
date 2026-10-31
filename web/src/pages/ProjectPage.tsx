import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ProjectView } from "../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Button } from "../controls/Button.tsx";
import { Dialog } from "../controls/Dialog.tsx";
import { TextField } from "../controls/TextField.tsx";
import { t } from "../i18n/translate.ts";
import { formatBytes } from "../format.ts";
import { useProjectKey } from "../router.ts";
import { projectName } from "./HomePage.tsx";
import { UploadPanel } from "../upload/UploadPanel.tsx";
import { PhotoFacts } from "../photos/PhotoFacts.tsx";
import { FolderImportPanel } from "../folders/FolderImportPanel.tsx";
import { RunStart } from "../run-start/RunStart.tsx";
import { RunHistory } from "../runs/RunHistory.tsx";
import { LinkSource } from "../links/LinkSource.tsx";
import type { FolderImportView } from "../../../shared/api-types.ts";

interface FormProps {
  project: ProjectView | null;
  name: string;
  notes: string;
  working: boolean;
  onName(value: string): void;
  onNotes(value: string): void;
  onSave(): void;
  onAskDelete(): void;
}
export function ProjectForm({ project, name, notes, working, onName, onNotes, onSave, onAskDelete }: FormProps) {
  const sample = project?.builtin === "sample";
  function submit(event: FormEvent) { event.preventDefault(); onSave(); }
  return <>
    <a href="#/">{t("projects.back")}</a>
    <h1>{project === null ? t("projects.new") : projectName(project)}</h1>
    {sample && <><p>{t("projects.sample_help")}</p><p><a href="#/sample">{t("projects.sample_link")}</a></p></>}
    {project?.resultsBytes !== undefined && <section><h2>{t("results.title")}</h2><p>{t("projects.results_total", { size: formatBytes(project.resultsBytes) })}</p>
      <ul>{project.resultArchives?.map(archive => <li key={archive.runId}><a href={`#/runs/${archive.runId}`}>{t("projects.result_run", { id: archive.runId })}</a>{t("results.size_suffix", { size: formatBytes(archive.size) })}</li>)}</ul>
    </section>}
    <form onSubmit={submit}>
      {!sample && <TextField id="project-name" label={t("projects.name")} value={name} onChange={event => onName(event.target.value)} required maxLength={200} />}
      <div className="field"><label htmlFor="project-notes">{t("projects.notes")}</label><textarea id="project-notes" value={notes} onChange={event => onNotes(event.target.value)} maxLength={100000} /></div>
      <Button type="submit" disabled={working}>{project === null ? t("projects.create") : t("projects.save")}</Button>
    </form>
    {project !== null && <p><Button className="secondary" disabled={working} onClick={onAskDelete}>{t("projects.delete")}</Button></p>}
  </>;
}

export function DeleteConfirmation({ working, onKeep, onDelete }: { working: boolean; onKeep(): void; onDelete(): void }) {
  return <>
    <h2>{t("projects.delete_title")}</h2><p>{t("projects.delete_explain")}</p>
    <Button className="secondary" disabled={working} onClick={onKeep}>{t("projects.keep")}</Button>{" "}
    <Button disabled={working} onClick={onDelete}>{t("projects.delete_confirm")}</Button>
  </>;
}

export function ProjectPage({ onAuthRequired }: { onAuthRequired: () => void }) {
  const key = useProjectKey();
  const [project, setProject] = useState<ProjectView | null>(null);
  const [loaded, setLoaded] = useState(key === "new");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [working, setWorking] = useState(false);
  const [asking, setAsking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [factsRefresh, setFactsRefresh] = useState(0);
  const [source, setSource] = useState<{ id: number; state: FolderImportView["state"] | null } | null>(null);
  const [link, setLink] = useState<{ id: number; url: string | null } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (asking) dialog.current?.showModal(); }, [asking]);
  useEffect(() => {
    let current = true;
    setProject(null); setName(""); setNotes(""); setFailure(null); setSaved(false); setLoaded(key === "new");
    if (key !== "new") api<ProjectView>("GET", `/api/projects/${key}`).then(value => {
      if (!current) return;
      setProject(value); setName(value.name); setNotes(value.notes); setLoaded(true);
    }, error => { if (current) showError(error); });
    return () => { current = false; };
  }, [key]);
  function showError(error: unknown) {
    const problem = asApiFailure(error);
    if (problem.code === "auth.passphrase_required") onAuthRequired(); else setFailure(problem);
  }
  async function save() {
    if (working) return;
    setWorking(true); setFailure(null); setSaved(false);
    try {
      const result = await api<ProjectView>(project === null ? "POST" : "PUT", project === null ? "/api/projects" : `/api/projects/${project.id}`, { name, notes });
      setProject(result); setName(result.name); setNotes(result.notes); setSaved(true);
      if (project === null) window.location.hash = `#/projects/${result.id}`;
    } catch (error) { showError(error); } finally { setWorking(false); }
  }
  async function remove() {
    if (working || project === null) return;
    setWorking(true); setFailure(null);
    try { await api<void>("DELETE", `/api/projects/${project.id}`); window.location.hash = "#/"; }
    catch (error) { setAsking(false); showError(error); } finally { setWorking(false); }
  }
  function refreshProject(id: number) {
    void api<ProjectView>("GET", `/api/projects/${id}`).then(value => {
      setProject(current => current?.id === id ? value : current);
    }, showError);
  }
  return <>
    {failure && <ErrorMessage failure={failure} />}
    {!loaded ? (!failure && <p>{t("projects.loading")}</p>) : <ProjectForm project={project} name={name} notes={notes} working={working} onName={setName} onNotes={setNotes} onSave={() => void save()} onAskDelete={() => setAsking(true)} />}
    <p role="status">{saved ? t("projects.saved") : null}</p>
    {loaded && project !== null && <RunHistory key={`history-${project.id}`} projectId={project.id} onAuthRequired={onAuthRequired} />}
    {loaded && project !== null && project.builtin !== "sample" && <RunStart key={project.id} projectId={project.id} onAuthRequired={onAuthRequired} />}
    {loaded && project !== null && project.builtin !== "sample" && <><LinkSource key={project.id} projectId={project.id} onSource={url => setLink({ id: project.id, url })} onAuthRequired={onAuthRequired} />{link?.id === project.id && link.url === null && <><FolderImportPanel key={project.id} projectId={project.id} onSource={state => setSource({ id: project.id, state })} onChange={() => { refreshProject(project.id); setFactsRefresh(value => value + 1); }} onAuthRequired={onAuthRequired} />{source?.id === project.id && source.state === "none" && <UploadPanel key={project.id} projectId={project.id} onChange={() => { refreshProject(project.id); setFactsRefresh(value => value + 1); }} onAuthRequired={onAuthRequired} />}{(source?.id !== project.id || source.state === null || source.state === "none" || source.state === "ready") && <><p role="status">{t("upload.arrived", { count: project.photoCount ?? t("run_start.not_reported") })}</p><PhotoFacts key={project.id} projectId={project.id} refresh={factsRefresh} onAuthRequired={onAuthRequired} /></>}</>}</>}
    {asking && <Dialog ref={dialog} label={t("projects.delete_title")} onCancel={event => { event.preventDefault(); if (!working) setAsking(false); }}>
      <DeleteConfirmation working={working} onKeep={() => setAsking(false)} onDelete={() => void remove()} />
    </Dialog>}
  </>;
}
