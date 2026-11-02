import { useState } from "react";
import type { FolderImportView, ProjectView } from "../../../../shared/api-types.ts";
import { PageHeader } from "../../controls/PageHeader.tsx";
import { FolderImportPanel } from "../../folders/FolderImportPanel.tsx";
import { t } from "../../i18n/translate.ts";
import { LinkSource } from "../../links/LinkSource.tsx";
import { projectName } from "../../pages/ProjectsPage.tsx";
import { PhotoFacts } from "../../photos/PhotoFacts.tsx";
import { UploadPanel } from "../../upload/UploadPanel.tsx";

/**
 * The Photos section: the three ways in, then the facts of what arrived. The
 * panels are the ones the project page had; the Photos ticket rebuilds them.
 */
export function PhotosSection({ project, onChange, onAuthRequired }: { project: ProjectView; onChange(): void; onAuthRequired(): void }) {
  const [factsRefresh, setFactsRefresh] = useState(0);
  const [source, setSource] = useState<FolderImportView["state"] | null>(null);
  const [link, setLink] = useState<{ url: string | null } | null>(null);
  const changed = () => { onChange(); setFactsRefresh((value) => value + 1); };
  return <>
    <PageHeader title={t("photos.visual.title")} subtitle={projectName(project)} />
    {project.builtin === "sample" ? <p>{t("projects.sample_help")}</p> : <>
      <LinkSource projectId={project.id} onSource={(url) => setLink({ url })} onAuthRequired={onAuthRequired} />
      {link?.url === null && <>
        <FolderImportPanel projectId={project.id} onSource={setSource} onChange={changed} onAuthRequired={onAuthRequired} />
        {source === "none" && <UploadPanel projectId={project.id} onChange={changed} onAuthRequired={onAuthRequired} />}
        {(source === null || source === "none" || source === "ready") && <>
          <p role="status">{t("upload.arrived", { count: project.photoCount ?? t("run_start.not_reported") })}</p>
          <PhotoFacts projectId={project.id} refresh={factsRefresh} onAuthRequired={onAuthRequired} />
        </>}
      </>}
    </>}
  </>;
}
