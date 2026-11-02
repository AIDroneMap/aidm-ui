import type { ReactNode } from "react";
import type { ProjectView } from "../../../shared/api-types.ts";
import { useRoute, type Section } from "../router.ts";
import { useWorkspaceProject } from "./useWorkspaceProject.ts";

type Render = (project: ProjectView, refresh: () => void) => ReactNode;

/**
 * For browser tests of one section on its own: reads the project from the
 * address, as the shell does, and renders only the sections a test names, so
 * the page bundles nothing else.
 */
export function SectionFixture({ sections }: { sections: Partial<Record<Section, Render>> }) {
  const route = useRoute();
  const { project, refresh } = useWorkspaceProject(route.screen === "project" ? route.projectId : null, () => {});
  if (route.screen !== "project" || project === null) return null;
  return <div key={project.id}>{sections[route.section]?.(project, refresh) ?? null}</div>;
}
