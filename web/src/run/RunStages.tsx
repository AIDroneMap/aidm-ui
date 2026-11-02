import type { RunView } from "../../../shared/api-types.ts";
import { Progress } from "../controls/Progress.tsx";
import { StageList, type Stage } from "../controls/StageList.tsx";
import { formatCount } from "../engines.ts";
import { formatClock } from "../format.ts";
import { t } from "../i18n/translate.ts";

/**
 * The engine's stages in order, each in plain words with its state and the
 * time AIDM UI saw it start. The current stage carries the engine's progress
 * and what the stage does. Before the engine names a stage, its progress
 * stands alone.
 */
export function RunStages({ run, level }: { run: RunView; level: 2 | 3 }) {
  const stages = run.stages ?? [];
  const Heading = level === 2 ? "h2" : "h3";
  const percent = run.state === "processing" && run.progress !== null ? Math.round(run.progress) : null;
  const items: Stage[] = stages.map((stage) => {
    const name = t(`run.stage.${stage.name}.name`);
    const running = stage.state === "running";
    // A stage that started but is neither done nor failed stopped with the run.
    const stopped = stage.state === "skipped" && stage.startedAt !== null;
    return {
      id: stage.name,
      name,
      state: stage.state,
      description: running ? (
        <>
          <span>{t(`run.stage.${stage.name}.description`)}</span>
          {percent !== null && <span className="run-stage-percent">{t("run.processing", { percent: formatCount(percent) })}</span>}
        </>
      ) : stopped ? t("run.screen.stage_stopped") : undefined,
      time: stage.startedAt ? <time dateTime={stage.startedAt}>{t("run.screen.stage_started", { time: formatClock(stage.startedAt) })}</time> : undefined,
      ...(running && percent !== null ? { progress: run.progress ?? 0, progressLabel: name } : {}),
    };
  });
  const current = stages.some((stage) => stage.state === "running");
  if (items.length === 0 && percent === null) return null;
  return (
    <section className="run-band run-stages" aria-labelledby="run-stages-title">
      <Heading id="run-stages-title">{t("run.screen.stages")}</Heading>
      {percent !== null && !current && (
        <Progress id="run-processing" label={t("run.processing", { percent: formatCount(percent) })} max={100} value={run.progress ?? 0} />
      )}
      {items.length > 0 && <StageList label={t("run.screen.stages")} stages={items} />}
    </section>
  );
}
