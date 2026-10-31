import { useEffect, useRef, useState } from "react";
import { Button } from "../controls/Button.tsx";
import { ApiFailure } from "../api.ts";
import { DownloadBlock, interruptionText } from "./DownloadBlock.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";
import { Results } from "./Results.tsx";
import { formatCount } from "../engines.ts";
import { t } from "../i18n/translate.ts";
import { isFinished, linesWithRestart, type Stage } from "../runs.ts";
import { RUN_STATES, type RunView } from "../../../shared/api-types.ts";

function LogView({ lines }: { lines: string[] }) {
  const box = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  // Follow new lines unless the operator scrolled up to read.
  useEffect(() => {
    const element = box.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [lines]);
  return (
    <>
      <h3 id="run-log-title">{t("run.log_title")}</h3>
      <pre
        ref={box}
        className="run-log"
        role="region"
        aria-labelledby="run-log-title"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        {lines.length === 0 ? t("run.log_empty") : lines.join("\n")}
      </pre>
    </>
  );
}

export interface RunProgressProps {
  run: RunView;
  stage: Stage | null;
  lines: string[];
  /** How many lines the run has written so far, counting the ones the page dropped. Needed to place the restart separator. */
  lineCount?: number;
  /** The line of the log where the engine's output began again after a restart. */
  restartedAtLine?: number | null;
  /** True while the live connection is down. */
  connectionLost: boolean;
  cancelling: boolean;
  failure: ApiFailure | null;
  onCancel: () => void;
  onAgain?: () => void;
}

/** A run in progress or finished: its state in words, its progress, its log and what the operator can do next. */
export function RunProgress({
  run: incomingRun,
  stage,
  lines,
  lineCount,
  restartedAtLine,
  connectionLost,
  cancelling,
  failure,
  onCancel,
  onAgain,
}: RunProgressProps) {
  const [run, setRun] = useState(incomingRun);
  useEffect(() => { setRun(incomingRun); }, [incomingRun]);
  const finished = isFinished(run);
  const known = (RUN_STATES as readonly string[]).includes(run.state);
  return (
    <>
      {run.engineName !== null && <p>{run.engineLocal ? t("run.engine_local") : t("run.engine", { name: run.engineName })}</p>}
      <p role="status" className="run-state">
        {t(run.step === "results" ? "run.results_fetching" : known ? `run.state.${run.state}` : "run.state.unknown")}
      </p>
      {run.state === "queued" && run.queueCount != null && <p>{t("run_manage.waiting", { count: run.queueCount })}</p>}
      {run.sample && <h2>{t("run.sample_name")}</h2>}
      {!run.sample && run.name && <h2>{run.name}</h2>}
      {stage && <section><h3>{t(`run.stage.${stage}.name`)}</h3><p>{t(`run.stage.${stage}.description`)}</p></section>}
      {connectionLost && !finished && <p className="hint">{t("run.live_paused")}</p>}
      {run.restarted && <p className="warning">{t("run.restarted")}</p>}

      {run.step === "download" && run.download && (
        <DownloadBlock
          title={t("run.download")}
          received={run.download.received}
          size={run.download.total > 0 ? run.download.total : null}
          speed={run.download.speed}
          interruption={interruptionText(run.download.retries, run.download.lastRetry)}
          progressId="run-download"
        />
      )}
      {run.step === "upload" && run.upload && (
        <div className="field">
          <label htmlFor="run-upload">
            {t("run.upload", { done: formatCount(run.upload.done), total: formatCount(run.upload.total) })}
          </label>
          <progress
            id="run-upload"
            max={run.upload.total > 0 ? run.upload.total : undefined}
            value={run.upload.total > 0 ? run.upload.done : undefined}
          />
        </div>
      )}
      {run.state === "processing" && run.progress !== null && (
        <div className="field">
          <label htmlFor="run-processing">{t("run.processing", { percent: formatCount(Math.round(run.progress)) })}</label>
          <progress id="run-processing" max={100} value={run.progress} />
        </div>
      )}

      {run.engineMessage !== null && (
        <div className="error">
          <p>{t("run.engine_said", { message: run.engineMessage })}</p>
        </div>
      )}
      {run.problem && <ErrorMessage failure={new ApiFailure(0, run.problem.code, run.problem.data)} />}
      {failure && <ErrorMessage failure={failure} />}

      <LogView
        lines={linesWithRestart(
          { lines, count: lineCount ?? lines.length },
          restartedAtLine ?? null,
          t("run.log_restarted"),
        )}
      />

      {run.results && <Results run={run} onChange={setRun} />}

      <div className="actions">
        {!finished && run.state !== "completed" && (
          <Button type="button" className="secondary" disabled={cancelling} onClick={onCancel}>
            {cancelling ? t("run.cancelling") : t("run.cancel")}
          </Button>
        )}
        {!run.results && run.state === "completed" && run.step !== "results" &&
          (run.resultsAvailable ? (
            <a href={`/api/runs/${run.id}/results`} download>
              {t("run.results_link")}
            </a>
          ) : (
            <span role="status">{t("run.results_preparing")}</span>
          ))}
        {finished && onAgain && (
          <Button type="button" className="secondary" onClick={onAgain}>
            {t("sample.again")}
          </Button>
        )}
      </div>
    </>
  );
}
