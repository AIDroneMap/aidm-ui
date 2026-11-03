import { useEffect, useRef, useState } from "react";
import type { FolderImportView, ProjectView } from "../../../../shared/api-types.ts";
import type { LinkSourceView } from "../../../../shared/link-source.ts";
import { api, asApiFailure, type ApiFailure } from "../../api.ts";
import { ErrorMessage } from "../../components/ErrorMessage.tsx";
import { PageHeader } from "../../controls/PageHeader.tsx";
import { t } from "../../i18n/translate.ts";
import { projectName } from "../../pages/ProjectsPage.tsx";
import { PhotosIntake } from "./PhotosIntake.tsx";
import { PhotosVisuals } from "./PhotosVisuals.tsx";
import "./photos.css";

export function PhotosSection({ project, onChange, onAuthRequired }: { project: ProjectView; onChange(): void; onAuthRequired(): void }) {
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState<{ folder: FolderImportView; link: LinkSourceView } | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const callbacks = useRef({ onChange, onAuthRequired }); callbacks.current = { onChange, onAuthRequired };
  useEffect(() => {
    if (project.builtin === "sample") return;
    let current = true;
    let timer: Timer | undefined;
    function load() { void Promise.all([
      api<FolderImportView>("GET", `/api/projects/${project.id}/import?limit=20`),
      api<LinkSourceView>("GET", `/api/projects/${project.id}/link`),
    ]).then(([folder, link]) => { if (current) { setSource({ folder, link }); setFailure(null); if (link.url !== null) timer = setTimeout(load, 3000); } }, error => {
      if (!current) return;
      const problem = asApiFailure(error);
      if (problem.code === "auth.passphrase_required") callbacks.current.onAuthRequired(); else setFailure(problem);
    }); }
    load();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [project.id, project.builtin, revision]);
  const changed = () => { callbacks.current.onChange(); setRevision(value => value + 1); };
  return <>
    <PageHeader title={t("photos.visual.title")} subtitle={projectName(project)} />
    {failure && <ErrorMessage failure={failure} />}
    {project.builtin === "sample" ? <p>{t("projects.sample_help")}</p> : source ? <>
      <PhotosIntake projectId={project.id} photoCount={project.photoCount ?? 0} localImportAllowed={source.folder.available} importView={source.folder} linkView={source.link} onChange={changed} onAuthRequired={onAuthRequired} />
      {source.link.url === null && <PhotosVisuals imported={source.folder.state !== "none"} projectId={project.id} refresh={revision} onChange={onChange} onAuthRequired={onAuthRequired} />}
    </> : !failure && <p role="status">{t("photos.visual.loading")}</p>}
  </>;
}
