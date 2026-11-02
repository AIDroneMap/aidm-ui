import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ProjectView, ProjectWriteRequest } from "../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Button } from "../controls/Button.tsx";
import { Dialog } from "../controls/Dialog.tsx";
import { EmptyState } from "../controls/EmptyState.tsx";
import { PageHeader } from "../controls/PageHeader.tsx";
import { Table } from "../controls/Table.tsx";
import { TextField } from "../controls/TextField.tsx";
import { IconFolderOpen } from "../icons/icons.tsx";
import { t } from "../i18n/translate.ts";
import { sectionHash } from "../router.ts";

export function projectName(project: ProjectView): string {
  return project.builtin === "sample" ? t("projects.sample_name") : project.name;
}

export function ProjectList({ projects, onNew }: { projects: ProjectView[]; onNew(): void }) {
  const create = <Button onClick={onNew}>{t("projects.new")}</Button>;
  if (projects.length === 0) return <>
    <PageHeader title={t("projects.title")} />
    <EmptyState icon={<IconFolderOpen />} title={t("projects.empty_title")} action={create}>{t("projects.empty")}</EmptyState>
  </>;
  return <>
    <PageHeader title={t("projects.title")} actions={create} />
    <div className="project-table"><Table label={t("projects.list")}>
      <thead><tr><th scope="col">{t("projects.name")}</th><th scope="col">{t("projects.photos")}</th><th scope="col">{t("projects.runs")}</th><th scope="col">{t("projects.latest")}</th><th scope="col">{t("projects.last_change")}</th></tr></thead>
      <tbody>{projects.map(project => <tr key={project.id}>
        <td><a href={sectionHash(project.id, "photos")}>{projectName(project)}</a></td>
        <td>{project.photoCount ?? t("run_start.not_reported")}</td><td>{project.runCount}</td>
        <td>{project.latestState === null ? t("projects.no_runs") : t(`run.state.${project.latestState}`)}</td>
        <td><time dateTime={project.lastChange}>{new Date(project.lastChange).toLocaleDateString()}</time></td>
      </tr>)}</tbody>
    </Table></div>
  </>;
}

/** Asks for a name, creates the project and opens its Photos section, because photos come first. */
export function NewProjectDialog({ onClose, onAuthRequired }: { onClose(): void; onAuthRequired(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true); setFailure(null);
    try {
      const project = await api<ProjectView>("POST", "/api/projects", { name, notes: "" } satisfies ProjectWriteRequest);
      window.location.hash = sectionHash(project.id, "photos");
    } catch (error) {
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") onAuthRequired(); else setFailure(problem);
      setWorking(false);
    }
  }
  return <Dialog ref={dialog} label={t("projects.new")} onCancel={event => { event.preventDefault(); if (!working) onClose(); }}>
    <form onSubmit={event => void submit(event)}>
      <h2>{t("projects.new")}</h2>
      <TextField id="new-project-name" label={t("projects.name")} hint={t("projects.new_hint")} value={name} onChange={event => setName(event.target.value)} required maxLength={200} />
      {failure && <ErrorMessage failure={failure} />}
      <p className="actions">
        <Button variant="secondary" disabled={working} onClick={onClose}>{t("projects.cancel")}</Button>
        <Button type="submit" disabled={working}>{t("projects.create")}</Button>
      </p>
    </form>
  </Dialog>;
}

export function ProjectsPage({ onAuthRequired }: { onAuthRequired: () => void }) {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    let current = true;
    api<ProjectView[]>("GET", "/api/projects").then(value => { if (current) setProjects(value); }, error => {
      if (!current) return;
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") onAuthRequired(); else setFailure(problem);
    });
    return () => { current = false; };
  }, []);
  if (failure) return <ErrorMessage failure={failure} />;
  if (projects === null) return <p>{t("projects.loading")}</p>;
  return <>
    <ProjectList projects={projects} onNew={() => setCreating(true)} />
    {creating && <NewProjectDialog onClose={() => setCreating(false)} onAuthRequired={onAuthRequired} />}
  </>;
}
