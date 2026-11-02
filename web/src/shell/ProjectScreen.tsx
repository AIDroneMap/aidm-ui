import type { ProjectView } from "../../../shared/api-types.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { t } from "../i18n/translate.ts";
import type { Route } from "../router.ts";
import { DetailsSection } from "../sections/details/DetailsSection.tsx";
import { PhotosSection } from "../sections/photos/PhotosSection.tsx";
import { ResultsSection } from "../sections/results/ResultsSection.tsx";
import { ReviewSection } from "../sections/review/ReviewSection.tsx";
import { RunsSection } from "../sections/runs/RunsSection.tsx";
import { SettingsSection } from "../sections/settings/SettingsSection.tsx";
import type { WorkspaceProject } from "./useWorkspaceProject.ts";

type ProjectRoute = Extract<Route, { screen: "project" }>;

/** The open section of a project. Each section starts afresh when the project changes. */
export function ProjectScreen({ route, workspace, onAuthRequired }: { route: ProjectRoute; workspace: WorkspaceProject; onAuthRequired(): void }) {
  const { project, failure, refresh } = workspace;
  if (failure) return <ErrorMessage failure={failure} />;
  if (project === null) return <p>{t("nav.loading_project")}</p>;
  return <Section key={project.id} route={route} project={project} refresh={refresh} onAuthRequired={onAuthRequired} />;
}

function Section({ route, project, refresh, onAuthRequired }: { route: ProjectRoute; project: ProjectView; refresh(): void; onAuthRequired(): void }) {
  switch (route.section) {
    case "photos": return <PhotosSection project={project} onChange={refresh} onAuthRequired={onAuthRequired} />;
    case "settings": return <SettingsSection project={project} onAuthRequired={onAuthRequired} />;
    case "review": return <ReviewSection project={project} />;
    case "runs": return <RunsSection project={project} onAuthRequired={onAuthRequired} />;
    case "results": return <ResultsSection project={project} runId={route.runId} viewer={route.viewer} onChange={refresh} onAuthRequired={onAuthRequired} />;
    case "details": return <DetailsSection project={project} onChange={refresh} onAuthRequired={onAuthRequired} />;
  }
}
