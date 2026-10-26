import { useEffect, useRef, useState } from "react";
import { api, ApiFailure, asApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { formatCount, formatMemory } from "../engines.ts";
import { formatBytes, formatDuration } from "../format.ts";
import { t } from "../i18n/translate.ts";
import {
  EMPTY_LOG,
  isFinished,
  isRunView,
  mergeLog,
  parseLogEvent,
  parseRunEvent,
  type LogLines,
} from "../runs.ts";
import {
  RUN_STATES,
  type RunLogView,
  type RunView,
  type SampleEngineOffer,
  type SampleStartRequest,
  type SampleView,
} from "../../../shared/api-types.ts";

// Server data of any shape; only strings and numbers can fill a placeholder.
function params(data: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

/** Why an engine cannot run the sample job. The cap and the peak come from the engine and the measurement, not from this computer. */
function reasonText(offer: SampleEngineOffer, peakMemory: number): string {
  if (offer.reason === null) return "";
  const figures: Record<string, string | number> = { peak: formatMemory(peakMemory) };
  if (offer.memoryCap !== null) figures["cap"] = formatMemory(offer.memoryCap);
  return t(offer.reason.code, { ...params(offer.reason.data), ...figures });
}

export interface SampleIntroProps {
  sample: SampleView;
  /** The engine chosen in the list, or null when none is offered. */
  engineId: number | null;
  onEngineChange: (engineId: number) => void;
  starting: boolean;
  failure: ApiFailure | null;
  onStart: () => void;
}

/** Everything the operator sees before a run: the photos, the measured figures and the choice of engine. */
export function SampleIntro({ sample, engineId, onEngineChange, starting, failure, onStart }: SampleIntroProps) {
  const { dataset, reference } = sample;
  const offered = sample.engines.filter((engine) => engine.offered);
  const refused = sample.engines.filter((engine) => !engine.offered);
  return (
    <>
      <p>{t("sample.intro")}</p>

      <h2>{t("sample.dataset.title")}</h2>
      <p>
        <strong>{dataset.name}</strong>
      </p>
      <dl className="facts">
        <dt>{t("sample.dataset.licence")}</dt>
        <dd>
          <a href={dataset.licenceUrl} rel="noopener noreferrer">
            {dataset.licence}
          </a>
        </dd>
        <dt>{t("sample.dataset.credit")}</dt>
        <dd>{dataset.attribution}</dd>
        <dt>{t("sample.dataset.images")}</dt>
        <dd>{formatCount(dataset.imageCount)}</dd>
        <dt>{t("sample.dataset.size")}</dt>
        <dd>{formatBytes(dataset.size)}</dd>
      </dl>
      <p>
        {reference
          ? t("sample.reference", {
              cores: reference.cores,
              memory: reference.memoryGiB,
              architecture: t(`sample.architecture.${reference.architecture}`),
              time: formatDuration(reference.seconds),
            })
          : t("sample.reference_none")}
      </p>
      <p>{t("sample.peak", { size: formatMemory(sample.peakMemory) })}</p>

      <h2>{t("sample.engine.title")}</h2>
      {offered.length === 0 ? (
        <p>
          {t("sample.engine.none")} <a href="#/engines">{t("sample.engine.go_to_engines")}</a>
        </p>
      ) : (
        <div className="field">
          <label htmlFor="sample-engine">{t("sample.engine.label")}</label>
          <select
            id="sample-engine"
            value={engineId ?? undefined}
            disabled={starting}
            onChange={(event) => onEngineChange(Number(event.target.value))}
          >
            {offered.map((engine) => (
              <option key={engine.engineId} value={engine.engineId}>
                {engine.engineName}
              </option>
            ))}
          </select>
        </div>
      )}
      {refused.length > 0 && (
        <>
          <h3>{t("sample.engine.unavailable_title")}</h3>
          <ul>
            {refused.map((engine) => (
              <li key={engine.engineId}>
                <strong>{engine.engineName}</strong>
                <br />
                <span>{reasonText(engine, sample.peakMemory)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {failure && <ErrorMessage failure={failure} />}
      {offered.length > 0 && (
        <p className="hint">{t("sample.start_hint", { size: formatBytes(dataset.size) })}</p>
      )}
      <div className="actions">
        {offered.length > 0 && (
          <button type="button" disabled={starting || engineId === null} onClick={onStart}>
            {starting ? t("sample.starting") : t("sample.start")}
          </button>
        )}
        <a href="#/">{t("sample.skip")}</a>
      </div>
    </>
  );
}

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
  lines: string[];
  /** True while the live connection is down. */
  connectionLost: boolean;
  cancelling: boolean;
  failure: ApiFailure | null;
  onCancel: () => void;
  onAgain: () => void;
}

/** A run in progress or finished: its state in words, its progress, its log and what the operator can do next. */
export function RunProgress({ run, lines, connectionLost, cancelling, failure, onCancel, onAgain }: RunProgressProps) {
  const finished = isFinished(run);
  const known = (RUN_STATES as readonly string[]).includes(run.state);
  return (
    <>
      {run.engineName !== null && <p>{t("run.engine", { name: run.engineName })}</p>}
      <p role="status" className="run-state">
        {t(known ? `run.state.${run.state}` : "run.state.unknown")}
      </p>
      {connectionLost && !finished && <p className="hint">{t("run.live_paused")}</p>}
      {run.restarted && <p className="warning">{t("run.restarted")}</p>}

      {run.step === "download" && run.download && (
        <div className="field">
          <label htmlFor="run-download">
            {t("run.download", { received: formatBytes(run.download.received), total: formatBytes(run.download.total) })}
          </label>
          <progress
            id="run-download"
            max={run.download.total > 0 ? run.download.total : undefined}
            value={run.download.total > 0 ? run.download.received : undefined}
          />
        </div>
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

      <LogView lines={lines} />

      <div className="actions">
        {!finished && (
          <button type="button" className="secondary" disabled={cancelling} onClick={onCancel}>
            {cancelling ? t("run.cancelling") : t("run.cancel")}
          </button>
        )}
        {run.state === "completed" &&
          (run.resultsAvailable ? (
            <a href={`/api/runs/${run.id}/results`} download>
              {t("run.results_link")}
            </a>
          ) : (
            <span role="status">{t("run.results_preparing")}</span>
          ))}
        {finished && (
          <button type="button" className="secondary" onClick={onAgain}>
            {t("sample.again")}
          </button>
        )}
      </div>
    </>
  );
}

export function SampleJobPage({ onAuthRequired }: { onAuthRequired: () => void }) {
  const [sample, setSample] = useState<SampleView | null>(null);
  const [engineId, setEngineId] = useState<number | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [log, setLog] = useState<LogLines>(EMPTY_LOG);
  const [connectionLost, setConnectionLost] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  // The latest callback, so the long-lived effects below never call a stale one.
  const authRequired = useRef(onAuthRequired);
  authRequired.current = onAuthRequired;
  // Lines held so far, readable from event handlers without a stale value.
  const logCount = useRef(0);
  logCount.current = log.count;

  const fail = (error: unknown): ApiFailure => {
    const result = asApiFailure(error);
    if (result.code === "auth.passphrase_required") authRequired.current();
    return result;
  };

  useEffect(() => {
    let current = true;
    api<SampleView>("GET", "/api/sample").then(
      (loaded) => {
        if (!current) return;
        setSample(loaded);
        setEngineId(loaded.engines.find((engine) => engine.offered)?.engineId ?? null);
        // After a reload the latest run is shown, but only a new one if the operator asks.
        setRun((existing) => existing ?? loaded.run);
      },
      (error: unknown) => {
        if (current) setFailure(fail(error));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const runId = run?.id ?? null;
  useEffect(() => {
    if (runId === null) return;
    let current = true;
    setLog(EMPTY_LOG);
    logCount.current = 0;
    const catchUp = (start?: number) => {
      const from = start ?? logCount.current;
      api<RunLogView>("GET", `/api/runs/${runId}/log?from=${from}`).then(
        (view) => {
          if (!current) return;
          setLog((existing) => mergeLog(existing, from, view.lines));
          // The server sends at most one page of lines, so ask again from where it ended.
          if (view.next > from) catchUp(view.next);
        },
        () => {
          // The live connection will bring the lines; nothing to show for a failed catch-up.
        },
      );
    };
    catchUp();
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onopen = () => setConnectionLost(false);
    source.onerror = () => setConnectionLost(true);
    source.addEventListener("run", (event) => {
      const view = parseRunEvent((event as MessageEvent<string>).data);
      if (!view || !current) return;
      setRun(view);
      setConnectionLost(false);
      if (isFinished(view)) {
        catchUp();
        source.close();
      }
    });
    source.addEventListener("log", (event) => {
      const block = parseLogEvent((event as MessageEvent<string>).data);
      if (!block || !current) return;
      if (block.from > logCount.current) {
        catchUp();
        return;
      }
      setLog((existing) => mergeLog(existing, block.from, block.lines));
    });
    return () => {
      current = false;
      source.close();
    };
  }, [runId]);

  const start = async () => {
    if (engineId === null) return;
    setStarting(true);
    setFailure(null);
    try {
      const view = await api<RunView>("POST", "/api/sample/start", { engineId } satisfies SampleStartRequest);
      setRun(view);
    } catch (error) {
      setFailure(fail(error));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (run === null) return;
    setCancelling(true);
    setFailure(null);
    try {
      const answer = await api<unknown>("POST", `/api/runs/${run.id}/cancel`);
      if (isRunView(answer)) setRun(answer);
    } catch (error) {
      setFailure(fail(error));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <h1>{t("sample.title")}</h1>
      {sample === null ? (
        failure ? <ErrorMessage failure={failure} /> : <p>{t("sample.loading")}</p>
      ) : run !== null ? (
        <RunProgress
          run={run}
          lines={log.lines}
          connectionLost={connectionLost}
          cancelling={cancelling}
          failure={failure}
          onCancel={() => void cancel()}
          onAgain={() => {
            setRun(null);
            setFailure(null);
            // Offers and memory may have changed during the run.
            api<SampleView>("GET", "/api/sample").then(
              (loaded) => {
                setSample(loaded);
                setEngineId(loaded.engines.find((engine) => engine.offered)?.engineId ?? null);
              },
              (error: unknown) => setFailure(fail(error)),
            );
          }}
        />
      ) : (
        <SampleIntro
          sample={sample}
          engineId={engineId}
          onEngineChange={setEngineId}
          starting={starting}
          failure={failure}
          onStart={() => void start()}
        />
      )}
    </>
  );
}
