import { useCallback, useEffect, useState } from "react";
import type { ProjectView } from "../../../shared/api-types.ts";
import { api, asApiFailure, type ApiFailure } from "../api.ts";

/** How often the open project is read again while any of its runs is unfinished, so the sidebar badges follow it. */
export const ACTIVE_PROJECT_POLL_MS = 5000;

/** True while any run of the project has not finished, on any engine. */
export function runActive(project: Pick<ProjectView, "activeRunCount">): boolean {
  return (project.activeRunCount ?? 0) > 0;
}

export type WorkspaceProject = {
  /** Null while the project loads, when it failed to load, or when no project is open. */
  project: ProjectView | null;
  failure: ApiFailure | null;
  /** Reads the project again, after a section changed it. */
  refresh: () => void;
};

/**
 * The project the sidebar and the open section show. One read per project,
 * shared by both, so a rename or an upload shows in the sidebar at once.
 */
export function useWorkspaceProject(projectId: number | null, onAuthRequired: () => void): WorkspaceProject {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads((value) => value + 1), []);

  useEffect(() => {
    setProject(null);
    setFailure(null);
  }, [projectId]);

  useEffect(() => {
    if (projectId === null) return;
    let current = true;
    api<ProjectView>("GET", `/api/projects/${projectId}`).then(
      (value) => {
        if (current) { setProject(value); setFailure(null); }
      },
      (error: unknown) => {
        if (!current) return;
        const problem = asApiFailure(error);
        if (problem.code === "auth.passphrase_required") onAuthRequired(); else setFailure(problem);
      },
    );
    return () => { current = false; };
  }, [projectId, reads]);

  const active = project !== null && project.id === projectId && runActive(project);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(refresh, ACTIVE_PROJECT_POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  return { project: project?.id === projectId ? project : null, failure, refresh };
}
