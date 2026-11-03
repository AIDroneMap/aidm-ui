import type { ReactNode } from "react";
import type { EngineState } from "../../../../shared/api-types.ts";
import type { OptionWarning } from "../../../../shared/option-warnings.ts";
import type { ReviewOption, RunReviewView } from "../../../../shared/run-review.ts";
import { ApiFailure } from "../../api.ts";
import { Button } from "../../controls/Button.tsx";
import { EmptyState } from "../../controls/EmptyState.tsx";
import { Notice } from "../../controls/Notice.tsx";
import { ENGINE_STATE_TONES, StatusPill } from "../../controls/StatusPill.tsx";
import { TextField } from "../../controls/TextField.tsx";
import { formatBytes } from "../../format.ts";
import { IconClipboardCheck } from "../../icons/icons.tsx";
import { t } from "../../i18n/translate.ts";
import { messageParams } from "../../machine.ts";
import { sectionHash } from "../../router.ts";
import { warningText } from "../settings/OptionWarnings.tsx";
import "./review.css";

/** Review before the operator has chosen the settings of a run: it sends them to Settings. */
export function ReviewPlaceholder({ projectId }: { projectId: number }) {
  return <EmptyState icon={<IconClipboardCheck />} action={<a className="button" href={sectionHash(projectId, "settings")}>{t("review.to_settings")}</a>}>
    {t("review.placeholder")}
  </EmptyState>;
}

function valueText(value: ReviewOption["value"]): string {
  return typeof value === "boolean" ? t(value ? "run_start.yes" : "run_start.no") : String(value);
}

/** Each option by its plain name, then the engine's name for it and the value the run sends. */
function Options({ options }: { options: readonly ReviewOption[] }) {
  return <ul className="review-options">{options.map((option) => {
    const key = `option.${option.name}.name`;
    const name = t(key);
    const missing = name === key;
    return <li key={option.name}>
      <span className="review-option-name">{missing ? option.name : name}</span>{" "}
      <code>{option.name}</code>{" "}
      <span className="review-option-value">{valueText(option.value)}</span>
      {(missing || option.unexplained) && <p className="review-option-help">{t("run_start.unexplained", { help: option.help })}</p>}
    </li>;
  })}</ul>;
}

type Props = {
  review: RunReviewView;
  /** The engine's state as the engine list last reported it, when known. */
  engineState: EngineState | null;
  name: string;
  onName(value: string): void;
  /** The engine selector. */
  engine: ReactNode;
  /** The in-place or copy choice of an imported folder, when it applies. */
  importChoice: ReactNode;
  /** The pages of the flight list. */
  flightPages: ReactNode;
  /** What moved when the engine changed. */
  moved: ReactNode;
  warnings: readonly OptionWarning[];
  working: boolean;
  onReload(): void;
  onBack(): void;
  onStart(): void;
};

/**
 * The Review screen (section 4 of docs/proposals/0001-desktop-class-interface.md): what will be
 * processed, on which engine and under which name on the left; what comes out, every changed option
 * and the warnings on the right. A blocked start says why above the buttons and changes nothing else.
 */
export function ReviewScreen({ review, engineState, name, onName, engine, importChoice, flightPages, moved, warnings, working, onReload, onBack, onStart }: Props) {
  const info = review.engine.info;
  const number = (value: number | null | undefined) => value == null ? t("run_start.not_reported") : String(value);
  const memory = (value: number | null | undefined) => value == null ? t("run_start.not_reported") : formatBytes(value);
  const { photos, blocked } = review;
  return <div className="review">
    <div className="review-columns">
      <div className="review-column">
        <section aria-labelledby="review-photos">
          <h2 id="review-photos">{t("review.processed")}</h2>
          {review.wayIn === "link" ? <p>{t("run_start.link_unknown")}</p> : photos.included !== null && photos.excluded !== null && photos.total !== null && photos.bytes !== null && <p>{t("run_start.photo_counts", { included: photos.included, excluded: photos.excluded, total: photos.total, size: formatBytes(photos.bytes) })}</p>}
          <p>{t(`run_start.way.${review.wayIn}`)}</p>
          {review.facts && <><ul>{review.facts.flights.map((flight) => <li key={flight.id}>{t("run_start.flight", { camera: [flight.make, flight.model].filter(Boolean).join(" ") || t("photos.unknown_camera"), first: flight.first, last: flight.last, count: flight.photoCount, excluded: flight.excludedPhotoCount })}</li>)}</ul>{flightPages}</>}
          {importChoice}
        </section>
        <section aria-labelledby="review-engine">
          <h2 id="review-engine">{t("run_start.engine_facts", { name: review.engine.name })}</h2>
          {engine}
          {engineState && <p><StatusPill tone={ENGINE_STATE_TONES[engineState]}>{t(`engine.state.${engineState}`)}</StatusPill></p>}
          <ul>
            <li>{t("run_start.version", { value: info?.version ?? t("run_start.not_reported") })}</li>
            <li>{t("run_start.engine_version", { value: info?.engineVersion ?? t("run_start.not_reported") })}</li>
            <li>{t("run_start.cores", { value: number(info?.cpuCores) })}</li>
            <li>{t("run_start.memory", { total: memory(info?.totalMemory), available: memory(info?.availableMemory) })}</li>
            <li>{t("run_start.queue", { value: number(info?.queueCount) })}</li>
            <li>{t("run_start.parallel", { value: number(info?.maxParallelTasks) })}</li>
            <li>{t("run_start.limit", { value: !review.engine.imageLimitReported ? t("run_start.not_reported") : review.engine.imageLimit === null ? t("run_start.no_limit") : number(review.engine.imageLimit) })}</li>
            <li>{t("run_start.gpu", { value: review.engine.gpu === null ? t("run_start.not_reported") : t(review.engine.gpu ? "run_start.yes" : "run_start.no") })}</li>
          </ul>
          {moved}
        </section>
        <section aria-labelledby="review-run">
          <h2 id="review-run">{t("review.run")}</h2>
          <TextField id="run-name" label={t("run_start.name")} hint={t("review.name_hint")} value={name} onChange={(event) => onName(event.target.value)} required maxLength={200} />
          <p>{t("run_start.selected_preset", { preset: review.presetName ?? t(`run_start.preset.${review.preset}`) })}</p>
        </section>
      </div>
      <div className="review-column">
        <section aria-labelledby="review-outputs">
          <h2 id="review-outputs">{t("review.outputs")}</h2>
          {review.outputs.length ? <ul>{review.outputs.map((output) => <li key={output}>{t(`run_start.output.${output}`)}</li>)}</ul> : <p>{t("review.no_outputs")}</p>}
          {review.alwaysProduced.length > 0 && <>
            <h3>{t("run_start.always_requested")}</h3>
            <p>{t("run_start.always_explain")}</p>
            <ul>{review.alwaysProduced.map((output) => <li key={output}>{t(`run_start.output.${output}`)}</li>)}</ul>
          </>}
        </section>
        <section aria-labelledby="review-changed">
          <h2 id="review-changed">{t("run_start.changed_options")}</h2>
          {review.options.length ? <Options options={review.options} /> : <p>{t("run_start.no_changes")}</p>}
          {review.serverSet.length > 0 && <>
            <h3>{t("review.server_set")}</h3>
            <p>{t("review.server_set_help")}</p>
            <Options options={review.serverSet} />
          </>}
        </section>
        {warnings.length > 0 && <section aria-labelledby="review-warnings">
          <h2 id="review-warnings">{t("review.warnings")}</h2>
          {warnings.map((warning) => <Notice key={warning.code} tone="warn" aria-label={t("warn.title")}>
            {warningText(warning)}
            {warning.code === "warn.hamming_cpu" && review.settings?.matcherWarning && <blockquote>{review.settings.matcherWarning}</blockquote>}
          </Notice>)}
        </section>}
      </div>
    </div>
    <div className="review-start">
      {blocked && <Notice tone="warn" role="alert" className="review-blocked">
        <p>{t(blocked.code, messageParams(new ApiFailure(0, blocked.code, blocked.data)))}</p>
      </Notice>}
      <div className="review-actions">
        <Button variant="quiet" disabled={working} onClick={onReload}>{t("run_start.reload")}</Button>
        <Button variant="secondary" disabled={working} onClick={onBack}>{t("settings.back")}</Button>
        <Button disabled={working || !!blocked || !name.trim()} onClick={onStart}>{t("review.start")}</Button>
      </div>
    </div>
  </div>;
}
