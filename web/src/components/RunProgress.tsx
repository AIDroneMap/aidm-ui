import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../controls/Button.tsx";
import { Notice } from "../controls/Notice.tsx";
import { ApiFailure } from "../api.ts";
import { DownloadBlock, interruptionText } from "./DownloadBlock.tsx";
import { ErrorMessage } from "./ErrorMessage.tsx";
import { formatCount } from "../engines.ts";
import { t } from "../i18n/translate.ts";
import { isFinished, linesWithRestart } from "../runs.ts";
import { RunFailure } from "../run/RunFailure.tsx";
import { RunHeader } from "../run/RunHeader.tsx";
import { RunLog } from "../run/RunLog.tsx";
import { RunResults } from "../run/RunResults.tsx";
import { RunStages } from "../run/RunStages.tsx";
import type { RunView } from "../../../shared/api-types.ts";
import "../run/run.css";

export interface RunProgressProps {
  run: RunView;
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
  /** The level of the run's name: 1 on the run's own screen, 2 inside a screen that has its own title. */
  level?: 1 | 2;
  /** Above the run's name: the way back to its project. */
  back?: ReactNode;
  /** What the operator can do with the run. Under the failure when the run failed. */
  actions?: ReactNode;
}

/**
 * The run screen, for every run, the sample job included. The band that
 * matters for the run's state comes first: the failure of a failed run, the
 * results of a finished one, then the stages, then the log, folded.
 */
export function RunProgress({
  run: incomingRun,
  lines,
  lineCount,
  restartedAtLine,
  connectionLost,
  cancelling,
  failure,
  onCancel,
  onAgain,
  level = 2,
  back,
  actions,
}: RunProgressProps) {
  const [run, setRun] = useState(incomingRun);
  useEffect(() => { setRun(incomingRun); }, [incomingRun]);
  const [logOpen, setLogOpen] = useState(false);
  const finished = isFinished(run);
  const band = level === 1 ? 2 : 3;
  const held = { lines, count: lineCount ?? lines.length };
  const showLog = () => {
    setLogOpen(true);
    // After the log opens, its panel takes the focus so the keyboard and a screen reader land there.
    requestAnimationFrame(() => document.querySelector<HTMLElement>("#run-log .run-log")?.focus());
  };
  return (
    <div className="run-screen">
      <RunHeader run={run} level={level} back={back} cancelling={cancelling} onCancel={onCancel} />

      {connectionLost && !finished && <Notice tone="warn"><p>{t("run.live_paused")}</p></Notice>}
      {run.restarted && <Notice tone="warn"><p>{t("run.restarted")}</p></Notice>}
      {run.state === "engine_unreachable" && <Notice tone="warn"><p>{t("run.screen.unreachable")}</p></Notice>}
      {failure && <ErrorMessage failure={failure} />}

      {run.state === "failed" ? (
        <RunFailure run={run} held={held} level={band} actions={actions} onShowLog={showLog} />
      ) : (
        <>
          {run.engineMessage !== null && <Notice tone="danger"><p>{t("run.engine_said", { message: run.engineMessage })}</p></Notice>}
          {run.problem && <ErrorMessage failure={new ApiFailure(0, run.problem.code, run.problem.data)} />}
        </>
      )}

      {run.state === "completed" && <RunResults run={run} onChange={setRun} />}

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
      {run.state === "queued" && run.queueCount != null && <p>{t("run_manage.waiting", { count: run.queueCount })}</p>}

      <RunStages run={run} level={band} />

      {run.state !== "failed" && actions}

      <RunLog
        runId={run.id}
        lines={linesWithRestart(held, restartedAtLine ?? null, t("run.log_restarted"))}
        count={held.count}
        open={logOpen}
        onToggle={setLogOpen}
      />

      {finished && onAgain && (
        <div className="actions">
          <Button variant="secondary" onClick={onAgain}>{t("sample.again")}</Button>
        </div>
      )}
    </div>
  );
}
