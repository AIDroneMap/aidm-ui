import { useEffect, useState, type ReactNode } from "react";
import { elapsedOf } from "../../../shared/run-stages.ts";
import { RUN_STATES, type RunView } from "../../../shared/api-types.ts";
import { Button } from "../controls/Button.tsx";
import { RUN_STATE_TONES, StatusPill } from "../controls/StatusPill.tsx";
import { formatDuration } from "../format.ts";
import { t } from "../i18n/translate.ts";
import { isFinished } from "../runs.ts";

/** The time now, read again every second while `ticking`, for a clock that counts from the run's creation. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** The run's state in words, as its pill shows it. */
export function runStateWords(run: RunView): string {
  if (run.step === "link") return t("run.linking");
  if (run.step === "results") return t("run.results_fetching");
  return t((RUN_STATES as readonly string[]).includes(run.state) ? `run.state.${run.state}` : "run.state.unknown");
}

/**
 * The top of the run screen: the run's name, its engine, its state and the
 * elapsed time, with Cancel while the run is unfinished. The elapsed time is
 * the engine's own processing time; before the engine reports one, the time
 * since the run was created, counted on this computer's clock.
 */
export function RunHeader({ run, level, back, cancelling, onCancel }: { run: RunView; level: 1 | 2; back?: ReactNode; cancelling: boolean; onCancel: () => void }) {
  const finished = isFinished(run);
  const processingTime = run.processingTime ?? null;
  const now = useNow(!finished && (processingTime === null || processingTime < 0));
  const elapsed = elapsedOf({ state: run.state, processingTime, createdAt: run.createdAt }, now);
  const Heading = level === 1 ? "h1" : "h2";
  const title = run.sample ? t("run.sample_name") : run.name ?? t("run.title", { id: run.id });
  const tone = run.step === "results" || run.step === "link" ? "running" : RUN_STATE_TONES[run.state] ?? "warn";
  const engine = run.engineName === null ? null : run.engineLocal ? t("run.engine_local") : t("run.engine", { name: run.engineName });
  const time = elapsed === null ? null
    : processingTime !== null && processingTime >= 0 ? t(finished ? "run.screen.elapsed.processed" : "run.screen.elapsed.processing", { time: formatDuration(elapsed / 1000) })
      : t("run.screen.elapsed.created", { time: formatDuration(elapsed / 1000) });
  return (
    <header className="run-header">
      <div className="run-header-text">
        {back}
        <Heading tabIndex={-1}>{title}</Heading>
        {(engine || time) && (
          <p className="run-header-facts">
            {engine && <span>{engine}</span>}
            {time && <span className="run-elapsed">{time}</span>}
          </p>
        )}
      </div>
      <div className="run-header-state">
        <p role="status" className="run-state">
          <StatusPill tone={tone}>{runStateWords(run)}</StatusPill>
        </p>
        {!finished && run.state !== "completed" && (
          <Button variant="secondary" disabled={cancelling} onClick={onCancel}>
            {cancelling ? t("run.cancelling") : t("run.cancel")}
          </Button>
        )}
      </div>
    </header>
  );
}
