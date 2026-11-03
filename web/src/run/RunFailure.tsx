import { useEffect, useState, type ReactNode } from "react";
import type { RunLogView, RunView } from "../../../shared/api-types.ts";
import type { RunFailureView } from "../../../shared/run-stages.ts";
import { api, ApiFailure } from "../api.ts";
import { Button } from "../controls/Button.tsx";
import { Notice } from "../controls/Notice.tsx";
import { formatCount } from "../engines.ts";
import { t } from "../i18n/translate.ts";
import { messageParams } from "../machine.ts";
import type { LogLines } from "../runs.ts";

/**
 * The lines of the failure range: from the lines the page holds when they
 * cover it, else from the log route, which the server pages.
 */
function useFailureLines(runId: number, failure: RunFailureView | null, held: LogLines): string[] | null {
  const from = failure?.from ?? 0;
  const to = failure?.to ?? 0;
  const first = held.count - held.lines.length;
  const fromHeld = failure !== null && from >= first && to <= held.count ? held.lines.slice(from - first, to - first) : null;
  const key = `${runId}:${from}:${to}`;
  const [fetched, setFetched] = useState<{ key: string; lines: string[] } | null>(null);
  const needed = failure !== null && fromHeld === null && to > from;
  useEffect(() => {
    if (!needed) return;
    let current = true;
    api<RunLogView>("GET", `/api/runs/${runId}/log?from=${from}`).then(
      (view) => {
        if (current) setFetched({ key, lines: view.lines.slice(0, to - from) });
      },
      () => {
        // The whole log is one click away; the excerpt is left out.
      },
    );
    return () => {
      current = false;
    };
  }, [key, needed]);
  return fromHeld ?? (fetched?.key === key ? fetched.lines : null);
}

/**
 * A failed run: the stage it failed in, the engine's own message, and the
 * last lines of the log with the first error marked, so the operator does
 * not read the whole log. What to do next sits under it.
 */
export function RunFailure({ run, held, level, actions, onShowLog }: { run: RunView; held: LogLines; level: 2 | 3; actions?: ReactNode; onShowLog: () => void }) {
  const failure = run.failure ?? null;
  const lines = useFailureLines(run.id, failure, held);
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section className="run-band run-failure" aria-labelledby="run-failure-title">
      <Notice tone="danger">
        <Heading id="run-failure-title">
          {failure?.stage ? t("run.screen.failure.in_stage", { stage: t(`run.stage.${failure.stage}.name`) }) : t("run.screen.failure.title")}
        </Heading>
        {run.engineMessage !== null && <p>{t("run.engine_said", { message: run.engineMessage })}</p>}
        {run.problem && <p>{t(run.problem.code, messageParams(new ApiFailure(0, run.problem.code, run.problem.data)))}</p>}
      </Notice>
      {failure && lines && lines.length > 0 && (
        <>
          <p className="run-failure-caption" id="run-failure-lines">
            {t(lines.length === 1 ? "run.screen.failure.lines_one" : "run.screen.failure.lines_other", { count: formatCount(lines.length) })}
          </p>
          <pre className="run-log run-failure-lines" role="region" aria-labelledby="run-failure-lines" tabIndex={0}>
            {lines.map((line, index) => failure.from + index === failure.errorLine ? (
              <mark key={index} className="run-log-line">
                <span className="visually-hidden">{t("run.screen.failure.first_error")}</span>
                {line}
              </mark>
            ) : (
              <span key={index} className="run-log-line">{line}</span>
            ))}
          </pre>
        </>
      )}
      {actions}
      <div className="actions">
        <Button variant="secondary" aria-controls="run-log" onClick={onShowLog}>{t("run.screen.failure.show_log")}</Button>
      </div>
    </section>
  );
}
