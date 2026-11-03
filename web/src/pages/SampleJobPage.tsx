import { Select } from "../controls/Select.tsx";
import { Button } from "../controls/Button.tsx";
import { useEffect, useState } from "react";
import { api, type ApiFailure } from "../api.ts";
import { RunProgress } from "../components/RunProgress.tsx";
export { RunProgress, type RunProgressProps } from "../components/RunProgress.tsx";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { formatCount, formatMemory } from "../engines.ts";
import { formatBytes, formatDuration } from "../format.ts";
import { t } from "../i18n/translate.ts";
import { useRun } from "../useRun.ts";
import {
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

/** The engine on this computer is named by the interface, in the operator's language. */
function engineLabel(engine: SampleEngineOffer): string {
  return engine.local ? t("engines.local_name") : engine.engineName;
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
  /** False inside the wizard, which has its own way out. */
  showSkip?: boolean;
}

/** Everything the operator sees before a run: the photos, the measured figures and the choice of engine. */
export function SampleIntro({ sample, engineId, onEngineChange, starting, failure, onStart, showSkip = true }: SampleIntroProps) {
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
        <Select
            label={t("sample.engine.label")}
            id="sample-engine"
            value={engineId ?? undefined}
            disabled={starting}
            onChange={(event) => onEngineChange(Number(event.target.value))}
          >
            {offered.map((engine) => (
              <option key={engine.engineId} value={engine.engineId}>
                {engineLabel(engine)}
              </option>
            ))}
        </Select>
      )}
      {refused.length > 0 && (
        <>
          <h3>{t("sample.engine.unavailable_title")}</h3>
          <ul>
            {refused.map((engine) => (
              <li key={engine.engineId}>
                <strong>{engineLabel(engine)}</strong>
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
          <Button type="button" disabled={starting || engineId === null} onClick={onStart}>
            {starting ? t("sample.starting") : t("sample.start")}
          </Button>
        )}
        {showSkip && <a href="#/">{t("sample.skip")}</a>}
      </div>
    </>
  );
}

export function SampleJobPage({
  onAuthRequired,
  embedded = false,
}: {
  onAuthRequired: () => void;
  /** Shown inside another screen that has its own heading, so this page leaves out its own. */
  embedded?: boolean;
}) {
  const [sample, setSample] = useState<SampleView | null>(null);
  const [engineId, setEngineId] = useState<number | null>(null);
  const { run, setRun, log, restartedAtLine, connectionLost, cancelling, failure, setFailure, fail, cancel } = useRun(onAuthRequired);
  const [starting, setStarting] = useState(false);

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


  return (
    <>
      {!embedded && <h1>{t("sample.title")}</h1>}
      {sample === null ? (
        failure ? <ErrorMessage failure={failure} /> : <p>{t("sample.loading")}</p>
      ) : run !== null ? (
        <RunProgress
          run={run}
          lines={log.lines}
          lineCount={log.count}
          restartedAtLine={restartedAtLine}
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
          showSkip={!embedded}
        />
      )}
    </>
  );
}
