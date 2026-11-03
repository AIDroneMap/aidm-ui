import type { ProjectView } from "../../../../shared/api-types.ts";
import { PageHeader } from "../../controls/PageHeader.tsx";
import { t } from "../../i18n/translate.ts";
import { projectName } from "../../pages/ProjectsPage.tsx";
import { sectionHash } from "../../router.ts";
import { RunStart } from "../../run-start/RunStart.tsx";

/**
 * The Settings and Review sections: the options workspace, then the review and the start of a run.
 * Both addresses render this one component, so the run's draft stays while the operator moves
 * between them; the address says which of the two shows. Without `section`, as in a test of
 * Settings alone, the review follows in place.
 */
export function SettingsSection({ project, section, onAuthRequired }: { project: ProjectView; section?: "settings" | "review"; onAuthRequired(): void }) {
  const routed = section === undefined ? {} : { step: section, onStep: (step: "settings" | "review") => { window.location.hash = sectionHash(project.id, step); } };
  return <>
    <PageHeader title={t(section === "review" ? "review.title" : "settings.title")} subtitle={projectName(project)} />
    {project.builtin === "sample" ? <p>{t("projects.sample_help")}</p> : <RunStart projectId={project.id} filterInAddress {...routed} onAuthRequired={onAuthRequired} />}
  </>;
}
