import type { ProjectView } from "../../../../shared/api-types.ts";
import { PageHeader } from "../../controls/PageHeader.tsx";
import { t } from "../../i18n/translate.ts";
import { projectName } from "../../pages/ProjectsPage.tsx";
import { RunStart } from "../../run-start/RunStart.tsx";

/** The Settings section: the run settings and the start of a run, as the project page had them until the options workspace replaces them. */
export function SettingsSection({ project, onAuthRequired }: { project: ProjectView; onAuthRequired(): void }) {
  return <>
    <PageHeader title={t("settings.title")} subtitle={projectName(project)} />
    {project.builtin === "sample" ? <p>{t("projects.sample_help")}</p> : <RunStart projectId={project.id} onAuthRequired={onAuthRequired} />}
  </>;
}
