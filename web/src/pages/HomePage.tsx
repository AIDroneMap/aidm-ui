import { useEffect, useState } from "react";
import type { ProjectView } from "../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Table } from "../controls/Table.tsx";
import { t } from "../i18n/translate.ts";

export function projectName(project: ProjectView): string {
  return project.builtin === "sample" ? t("projects.sample_name") : project.name;
}

export function ProjectList({ projects }: { projects: ProjectView[] }) {
  return <>
    <a className="button" href="#/projects/new">{t("projects.new")}</a>
    <h1>{t("projects.title")}</h1>
    {projects.length === 0 ? <p>{t("projects.empty")}</p> : <div className="project-table"><Table label={t("projects.list")}>
      <thead><tr><th scope="col">{t("projects.name")}</th><th scope="col">{t("projects.photos")}</th><th scope="col">{t("projects.runs")}</th><th scope="col">{t("projects.latest")}</th><th scope="col">{t("projects.last_change")}</th></tr></thead>
      <tbody>{projects.map(project => <tr key={project.id}>
        <td><a href={`#/projects/${project.id}`}>{projectName(project)}</a></td>
        <td>{project.photoCount}</td><td>{project.runCount}</td>
        <td>{project.latestState === null ? t("projects.no_runs") : t(`run.state.${project.latestState}`)}</td>
        <td><time dateTime={project.lastChange}>{new Date(project.lastChange).toLocaleDateString()}</time></td>
      </tr>)}</tbody>
    </Table></div>}
  </>;
}

export function HomePage({ onAuthRequired }: { onAuthRequired: () => void }) {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
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
  return projects === null ? <p>{t("projects.loading")}</p> : <ProjectList projects={projects} />;
}
