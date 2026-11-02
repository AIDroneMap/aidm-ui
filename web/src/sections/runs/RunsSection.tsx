import type { ProjectView } from "../../../../shared/api-types.ts";
import { PageHeader } from "../../controls/PageHeader.tsx";
import { t } from "../../i18n/translate.ts";
import { projectName } from "../../pages/ProjectsPage.tsx";
import { SampleJobPage } from "../../pages/SampleJobPage.tsx";
import { RunHistory } from "../../runs/RunHistory.tsx";

/** The Runs section: the project's runs, newest first. The sample project also offers the sample job here, where the old sample page sent it. */
export function RunsSection({ project, onAuthRequired }: { project: ProjectView; onAuthRequired(): void }) {
  return <>
    <PageHeader title={t("runs.title")} subtitle={projectName(project)} />
    {project.builtin === "sample" && <SampleJobPage embedded onAuthRequired={onAuthRequired} />}
    <RunHistory projectId={project.id} onAuthRequired={onAuthRequired} />
  </>;
}
