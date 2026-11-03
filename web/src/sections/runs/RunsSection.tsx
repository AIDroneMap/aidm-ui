import { useState } from "react";
import type { ProjectView, RunView } from "../../../../shared/api-types.ts";
import { PageHeader } from "../../controls/PageHeader.tsx";
import { t } from "../../i18n/translate.ts";
import { projectName } from "../../pages/ProjectsPage.tsx";
import { SampleJobPage } from "../../pages/SampleJobPage.tsx";
import { RunStart } from "../../run-start/RunStart.tsx";
import { RunsTable } from "./RunsTable.tsx";
import "./RunsSection.css";

export function RunsSection({ project, onAuthRequired }: { project: ProjectView; onAuthRequired(): void }) {
  const [again, setAgain] = useState<{ runId: number; request: number } | null>(null);

  function handleAgain(run: RunView) {
    setAgain(previous => ({ runId: run.id, request: (previous?.request ?? 0) + 1 }));
  }

  return (
    <>
      <PageHeader title={t("runs.title")} subtitle={projectName(project)} />
      {project.builtin === "sample" && project.runCount > 0 && <SampleJobPage embedded onAuthRequired={onAuthRequired} />}
      <RunsTable
        project={project}
        onAgain={handleAgain}
        onAuthRequired={onAuthRequired}
      />
      {again !== null && (
        <RunStart
          key={`again-${again.request}`}
          projectId={project.id}
          sourceRunId={again.runId}
          onAuthRequired={onAuthRequired}
        />
      )}
    </>
  );
}
