import type { ProjectView } from "../../../../shared/api-types.ts";
import { EmptyState } from "../../controls/EmptyState.tsx";
import { PageHeader } from "../../controls/PageHeader.tsx";
import { IconClipboardCheck } from "../../icons/icons.tsx";
import { t } from "../../i18n/translate.ts";
import { projectName } from "../../pages/ProjectsPage.tsx";
import { sectionHash } from "../../router.ts";

/** The Review section. Until the options workspace builds it, the review and the start stay in Settings, and this screen sends the operator there. */
export function ReviewSection({ project }: { project: ProjectView }) {
  return <>
    <PageHeader title={t("review.title")} subtitle={projectName(project)} />
    <EmptyState icon={<IconClipboardCheck />} action={<a className="button" href={sectionHash(project.id, "settings")}>{t("review.to_settings")}</a>}>
      {t("review.placeholder")}
    </EmptyState>
  </>;
}
