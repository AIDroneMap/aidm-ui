import { useId, type ReactNode } from "react";
import { IconCircle, IconCircleCheck, IconCircleDashed, IconCircleX, IconLoaderCircle } from "../icons/icons.tsx";
import { t } from "../i18n/translate.ts";
import { Progress } from "./Progress.tsx";

export type StageState = "waiting" | "running" | "done" | "skipped" | "failed";

export type Stage = {
  id: string;
  name: ReactNode;
  state: StageState;
  /** One line on what the stage does, or what the engine says it is doing. */
  description?: ReactNode;
  /** When the stage started, as the screen saw it. */
  time?: ReactNode;
  /** The engine's own percentage for the running stage. */
  progress?: number;
  /** The stage's name as plain text, for the progress bar's label. */
  progressLabel?: string;
};

const ICONS = { waiting: IconCircle, running: IconLoaderCircle, done: IconCircleCheck, skipped: IconCircleDashed, failed: IconCircleX };

/** The stages of a run in order, each with its state in words. */
export function StageList({ label, stages }: { label: string; stages: readonly Stage[] }) {
  const base = useId();
  return (
    <ol className="stage-list" aria-label={label}>
      {stages.map((stage) => {
        const Icon = ICONS[stage.state];
        return (
          <li key={stage.id} className={`stage stage-${stage.state}`} aria-current={stage.state === "running" ? "step" : undefined}>
            <Icon className="stage-icon" />
            <div className="stage-text">
              <span className="stage-name">{stage.name}</span>
              <span className="stage-state">{t(`ui.stage.${stage.state}`)}</span>
              {stage.description ? <p className="stage-description">{stage.description}</p> : null}
              {stage.progress !== undefined ? <Progress id={`${base}-${stage.id}`} label={t("ui.stage.progress", { name: stage.progressLabel ?? "" })} hideLabel max={100} value={stage.progress} /> : null}
            </div>
            {stage.time ? <span className="stage-time">{stage.time}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
