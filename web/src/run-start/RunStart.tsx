import { useEffect, useRef, useState } from "react";
import type { EngineView, RunView } from "../../../shared/api-types.ts";
import { PRESET_IDS, type PresetId } from "../../../shared/option-catalogue.ts";
import type { ReviewOption, RunReviewView } from "../../../shared/run-review.ts";
import { api, asApiFailure, ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Button } from "../controls/Button.tsx";
import { Select } from "../controls/Select.tsx";
import { TextField } from "../controls/TextField.tsx";
import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";

function optionValue(value: ReviewOption["value"]): string {
  return typeof value === "boolean" ? t(value ? "run_start.yes" : "run_start.no") : String(value);
}

export function OptionList({ options }: { options: ReviewOption[] }) {
  if (!options.length) return <p>{t("run_start.no_changes")}</p>;
  return <ul>{options.map(option => {
    const key = `option.${option.name}.name`;
    const name = t(key);
    const missing = name === key;
    return <li key={option.name}>{t("run_start.option", { name: missing ? option.name : name, engine: option.name, value: optionValue(option.value) })}
      {(missing || option.unexplained) && <p>{t("run_start.unexplained", { help: option.help })}</p>}</li>;
  })}</ul>;
}

export function RunStart({ projectId, onAuthRequired }: { projectId: number; onAuthRequired(): void }) {
  const [open, setOpen] = useState(false);
  const [engines, setEngines] = useState<EngineView[]>([]);
  const [engineId, setEngineId] = useState<number | null>(null);
  const [preset, setPreset] = useState<PresetId>("quick-map");
  const [review, setReview] = useState<RunReviewView | null>(null);
  const [step, setStep] = useState<"preset" | "review">("preset");
  const [name, setName] = useState("");
  const [offset, setOffset] = useState(0);
  const [offsets, setOffsets] = useState<number[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [changed, setChanged] = useState(false);
  const generation = useRef(0);
  const snapshot = useRef<string | null>(null);
  const auth = useRef(onAuthRequired); auth.current = onAuthRequired;
  function fail(error: unknown) {
    const problem = asApiFailure(error);
    if (problem.code === "auth.passphrase_required") auth.current(); else setFailure(problem);
  }
  useEffect(() => {
    if (!open) return;
    let current = true;
    api<EngineView[]>("GET", "/api/engines").then(value => {
      if (!current) return;
      const available = value.filter(engine => engine.enabled);
      setEngines(available); setEngineId(available[0]?.id ?? null);
    }, error => { if (current) fail(error); });
    return () => { current = false; };
  }, [open, projectId]);
  useEffect(() => {
    if (!open || engineId === null) return;
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true); setFailure(null); setChanged(false);
    api<RunReviewView>("GET", `/api/projects/${projectId}/run-review?engineId=${engineId}&preset=${preset}&offset=${offset}`).then(value => {
      if (current !== generation.current) return;
      if (offset !== 0 && value.revision !== snapshot.current) {
        setReview(null); setChanged(true); setLoading(false); return;
      }
      if (offset === 0) snapshot.current = value.revision;
      setReview(value); setLoading(false);
      if (value.facts && value.facts.pendingMetadata > 0) timer = setTimeout(() => setRefresh(value => value + 1), 300);
    }, error => { if (current === generation.current) { setReview(null); setLoading(false); fail(error); } });
    return () => { generation.current++; clearTimeout(timer); };
  }, [open, projectId, engineId, preset, offset, refresh]);
  function changePreset(value: PresetId) { setLoading(true); setReview(null); setPreset(value); setOffset(0); setOffsets([]); }
  function changeEngine(value: number) { setLoading(true); setReview(null); setEngineId(value); setOffset(0); setOffsets([]); }
  function next() {
    setName(t("run_start.default_name", { preset: t(`run_start.preset.${preset}`), date: new Intl.DateTimeFormat().format(new Date()) }));
    setStep("review");
  }
  async function start() {
    if (!review || loading || working || review.blocked || engineId === null) return;
    setWorking(true); setFailure(null);
    try {
      const run = await api<RunView>("POST", `/api/projects/${projectId}/runs`, { engineId, preset, name, revision: review.revision });
      window.location.hash = `#/runs/${run.id}`;
    } catch (error) { fail(error); } finally { setWorking(false); }
  }
  const info = review?.engine.info;
  const number = (value: number | null | undefined) => value == null ? t("run_start.not_reported") : String(value);
  const memory = (value: number | null | undefined) => value == null ? t("run_start.not_reported") : formatBytes(value);
  return <section aria-labelledby="run-start-title">
    <h2 id="run-start-title">{t("run_start.title")}</h2>
    {!open ? <Button onClick={() => setOpen(true)}>{t("run_start.choose")}</Button> : <>
      <Select id="run-engine" label={t("run_start.engine")} value={engineId ?? ""} onChange={event => changeEngine(Number(event.target.value))} disabled={working}>
        {!engines.length && <option value="">{t("run_start.no_engines")}</option>}
        {engines.map(engine => <option key={engine.id} value={engine.id}>{engine.name}</option>)}
      </Select>
      {loading && <p role="status">{t("run_start.loading")}</p>}
      {failure && <ErrorMessage failure={failure} />}
      {changed && <><p role="alert">{t("run_start.changed")}</p><Button onClick={() => { setOffsets([]); setOffset(0); }}>{t("run_start.reload")}</Button></>}
      {step === "preset" && <>
        <fieldset disabled={working}><legend>{t("run_start.presets")}</legend>
          {PRESET_IDS.map(id => <div key={id}><label><input type="radio" name="preset" value={id} checked={preset === id} onChange={() => changePreset(id)} /> {t(`run_start.preset.${id}`)}</label>
            <p>{t(`run_start.description.${id}`)}</p>
            {review && !loading && <OptionList options={review.presets.find(item => item.id === id)?.departures ?? []} />}
          </div>)}
        </fieldset>
        <Button disabled={!review || loading || working} onClick={next}>{t("run_start.review")}</Button>
      </>}
      {step === "review" && review && !loading && <>
        <h3>{t("run_start.review")}</h3>
        <p>{t("run_start.project", { name: review.project.name })}</p>
        <TextField id="run-name" label={t("run_start.name")} value={name} onChange={event => setName(event.target.value)} required maxLength={200} />
        <p>{t("run_start.selected_preset", { preset: t(`run_start.preset.${review.preset}`) })}</p>
        <h4>{t("run_start.photos")}</h4>
        {review.wayIn === "link" ? <p>{t("run_start.link_unknown")}</p> : review.photos.included !== null && review.photos.excluded !== null && review.photos.total !== null && review.photos.bytes !== null && <p>{t("run_start.photo_counts", { included: review.photos.included, excluded: review.photos.excluded, total: review.photos.total, size: formatBytes(review.photos.bytes) })}</p>}
        <p>{t(`run_start.way.${review.wayIn}`)}</p>
        {review.facts && <><ul>{review.facts.flights.map(flight => <li key={flight.id}>{t("run_start.flight", { camera: [flight.make, flight.model].filter(Boolean).join(" ") || t("photos.unknown_camera"), first: flight.first, last: flight.last, count: flight.photoCount, excluded: flight.excludedPhotoCount })}</li>)}</ul>
        {offsets.length > 0 && <Button className="secondary" onClick={() => { setLoading(true); setOffset(offsets[offsets.length - 1]!); setOffsets(offsets.slice(0, -1)); }}>{t("upload.previous")}</Button>}
        {review.facts.nextOffset !== null && <Button className="secondary" onClick={() => { setLoading(true); setOffsets([...offsets, offset]); setOffset(review.facts!.nextOffset!); }}>{t("upload.next")}</Button>}</>}
        <h4>{t("run_start.engine_facts", { name: review.engine.name })}</h4>
        <ul><li>{t("run_start.version", { value: info?.version ?? t("run_start.not_reported") })}</li>
          <li>{t("run_start.engine_version", { value: info?.engineVersion ?? t("run_start.not_reported") })}</li>
          <li>{t("run_start.cores", { value: number(info?.cpuCores) })}</li>
          <li>{t("run_start.memory", { total: memory(info?.totalMemory), available: memory(info?.availableMemory) })}</li>
          <li>{t("run_start.queue", { value: number(info?.queueCount) })}</li>
          <li>{t("run_start.parallel", { value: number(info?.maxParallelTasks) })}</li>
          <li>{t("run_start.limit", { value: !review.engine.imageLimitReported ? t("run_start.not_reported") : review.engine.imageLimit === null ? t("run_start.no_limit") : number(review.engine.imageLimit) })}</li>
          <li>{t("run_start.gpu", { value: review.engine.gpu === null ? t("run_start.not_reported") : t(review.engine.gpu ? "run_start.yes" : "run_start.no") })}</li></ul>
        <h4>{t("run_start.changed_options")}</h4><OptionList options={review.options} />
        <h4>{t("run_start.outputs")}</h4><ul>{review.outputs.map(output => <li key={output}>{t(`run_start.output.${output}`)}</li>)}</ul>
        <h4>{t("run_start.always_requested")}</h4><p>{t("run_start.always_explain")}</p><ul>{review.alwaysProduced.map(output => <li key={output}>{t(`run_start.output.${output}`)}</li>)}</ul>
        {review.blocked && <ErrorMessage failure={new ApiFailure(0, review.blocked.code, review.blocked.data)} />}
        <Button className="secondary" disabled={working} onClick={() => { setOffset(0); setOffsets([]); setRefresh(value => value + 1); }}>{t("run_start.reload")}</Button>{" "}
        <Button className="secondary" disabled={working} onClick={() => setStep("preset")}>{t("run_start.back")}</Button>{" "}
        <Button disabled={working || !!review.blocked || !name.trim()} onClick={() => void start()}>{t("run_start.start")}</Button>
      </>}
    </>}
  </section>;
}
