import { useEffect, useRef, useState } from "react";
import type { RunSeed } from "../../../shared/run-management.ts";
import type { EngineView, RunView } from "../../../shared/api-types.ts";
import { rebaseSettings, resolveSettings, type MovedSetting, type SettingsDraft } from "../../../shared/run-settings.ts";
import type { ReconciledOption } from "../../../shared/engine-options.ts";
import { PresetLibrary } from "../run-settings/PresetLibrary.tsx";
import { reconcileSettingsFile, type SettingsFile, type SettingValue, type DroppedSetting } from "../../../shared/settings-file.ts";
import { planPreset } from "../../../shared/run-plan.ts";
import { SettingsEditor } from "../run-settings/SettingsEditor.tsx";
import { PRESET_IDS, type PresetId } from "../../../shared/option-catalogue.ts";
import type { ImportMode, ReviewOption, RunReviewView } from "../../../shared/run-review.ts";
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

export function ImportChoice({ value, onChange, disabled = false }: { value: NonNullable<RunReviewView["importMode"]>; onChange(mode: ImportMode): void; disabled?: boolean }) {
  const fieldset = useRef<HTMLFieldSetElement>(null);
  const restoreFocus = useRef(false);
  function choose(mode: ImportMode) { restoreFocus.current = true; onChange(mode); }
  useEffect(() => {
    if (restoreFocus.current && !disabled) {
      if (document.activeElement === document.body || fieldset.current?.contains(document.activeElement)) fieldset.current?.querySelector<HTMLInputElement>(`input[value="${value.selected}"]`)?.focus();
      restoreFocus.current = false;
    }
  }, [disabled, value.selected]);
  if (!value.available) return <p>{t(value.selectionRequiresCopy ? "run_start.import_selection_copy" : "run_start.import_copy")}</p>;
  return <fieldset ref={fieldset} disabled={disabled}><legend>{t("run_start.import_choice")}</legend>
    <label><input type="radio" name="import-mode" value="in-place" checked={value.selected === "in-place"} onChange={() => choose("in-place")} /> {t("run_start.import_in_place")}</label>
    <label><input type="radio" name="import-mode" value="copy" checked={value.selected === "copy"} onChange={() => choose("copy")} /> {t("run_start.import_copy")}</label>
    <p>{t("run_start.import_copy_help")}</p>
    {value.selected === "in-place" && value.restartRequired && <p>{t("run_start.import_restart")}</p>}
  </fieldset>;
}

export function RunStart({ projectId, sourceRunId, onAuthRequired }: { projectId: number; sourceRunId?: number; onAuthRequired(): void }) {
  const [open, setOpen] = useState(sourceRunId !== undefined);
  const [importMode, setImportMode] = useState<ImportMode | undefined>();
  const seedEditing = useRef(sourceRunId !== undefined);
  const [draft, setDraft] = useState<SettingsDraft>({});
  const [applied, setApplied] = useState<Array<{ name: string; value: ReviewOption["value"] }>>([]);
  const [loaded, setLoaded] = useState<{ file: SettingsFile; id: number | null; baseline: SettingValue[] } | null>(null);
  const [dropped, setDropped] = useState<DroppedSetting[]>([]);
  const pendingFile = useRef<{ file: SettingsFile; id: number | null } | null>(null);
  const presetName = loaded?.file.preset;
  const [editing, setEditing] = useState(false);
  const [moved, setMoved] = useState<MovedSetting[]>([]);
  const editorBefore = useRef<SettingsDraft>({});
  const switching = useRef<{ options: ReconciledOption[]; draft: SettingsDraft; baseline?: SettingValue[] } | null>(null);
  const settingsKey = JSON.stringify(applied);
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
    setImportMode(undefined); setDraft({}); setApplied([]); setMoved([]); setEditing(false); switching.current = null; setLoaded(null); setDropped([]); pendingFile.current = null;
  }, [projectId]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    Promise.all([api<EngineView[]>("GET", "/api/engines"), sourceRunId === undefined ? Promise.resolve(null) : api<RunSeed>("GET", `/api/runs/${sourceRunId}/settings`)]).then(([value, seed]) => {
      if (!current) return;
      const available = value.filter(engine => engine.enabled);
      setEngines(available); setEngineId(available.find(engine => engine.id === seed?.engineId)?.id ?? available[0]?.id ?? null);
      if (seed) {
        chooseFile({ options: seed.options, preset: seed.presetName ?? t(`run_start.preset.${seed.preset ?? "custom"}`), engineVersion: null }, null);
        setName(seed.name ?? ""); setStep("review");
      }
    }, error => { if (current) fail(error); });
    return () => { current = false; };
  }, [open, projectId, sourceRunId]);
  useEffect(() => {
    if (!open || engineId === null) return;
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true); setFailure(null); setChanged(false);
    const pending = importMode !== undefined || sourceRunId !== undefined || applied.length || presetName !== undefined
      ? api<RunReviewView>("POST", `/api/projects/${projectId}/run-review`, { engineId, preset, offset, options: applied, presetName, sourceRunId, importMode })
      : api<RunReviewView>("GET", `/api/projects/${projectId}/run-review?engineId=${engineId}&preset=${preset}&offset=${offset}`);
    pending.then(value => {
      if (current !== generation.current) return;
      if (offset !== 0 && value.revision !== snapshot.current) {
        setReview(null); setChanged(true); setLoading(false); return;
      }
      if (pendingFile.current && value.settings) {
        const selected = pendingFile.current; pendingFile.current = null;
        const restored = reconcileSettingsFile(selected.file, value.settings.options);
        setLoaded({ ...selected, baseline: restored.values }); setDropped(restored.dropped); setDraft({});
        const resolved = resolveSettings(value.settings.options, preset, {}, value.settings.facts, restored.values);
        const edits = Object.entries(resolved.values).map(([name, value]) => ({ name, value }));
        if (edits.length) { setApplied(edits); return; }
      }
      if (switching.current && value.settings) {
        const previous = switching.current; switching.current = null;
        const baseline = loaded ? reconcileSettingsFile(loaded.file, value.settings.options) : null;
        if (loaded && baseline) { setLoaded({ ...loaded, baseline: baseline.values }); setDropped(baseline.dropped); }
        const rebased = rebaseSettings(previous.options, value.settings.options, preset, previous.draft, value.settings.facts, { previous: previous.baseline, next: baseline?.values });
        setDraft(rebased.draft); setMoved(rebased.moved);
        const resolved = resolveSettings(value.settings.options, preset, rebased.draft, value.settings.facts, baseline?.values);
        const edits = loaded ? Object.entries(resolved.values).map(([name, value]) => ({ name, value })) : resolved.overrides;
        if (edits.length) { setApplied(edits); return; }
      }
      if (offset === 0) snapshot.current = value.revision;
      setReview(value); setLoading(false);
      if (seedEditing.current && value.settings) { seedEditing.current = false; setEditing(true); }
      if (value.facts && value.facts.pendingMetadata > 0) timer = setTimeout(() => setRefresh(value => value + 1), 300);
    }, error => { if (current === generation.current) { setReview(null); setLoading(false); fail(error); } });
    return () => { generation.current++; clearTimeout(timer); };
  }, [open, projectId, engineId, preset, offset, refresh, settingsKey, presetName, sourceRunId, importMode]);
  function changePreset(value: PresetId) {
    setDraft({}); setApplied([]); setMoved([]); setEditing(false); switching.current = null; setLoaded(null); setDropped([]); pendingFile.current = null;
    setLoading(true); setReview(null); setPreset(value); setOffset(0); setOffsets([]);
  }
  function changeEngine(value: number) {
    setImportMode(undefined);
    if (review?.settings) switching.current = { options: review.settings.options, draft, baseline: loaded?.baseline };
    setApplied([]); setMoved([]); setLoading(true); setReview(null); setEngineId(value); setOffset(0); setOffsets([]);
  }
  function reloadReview() {
    if (engineId !== null) changeEngine(engineId);
    setRefresh(value => value + 1);
  }
  function editSettings() { editorBefore.current = draft; setEditing(true); }
  function applySettings() {
    if (!review?.settings) return;
    const resolved = resolveSettings(review.settings.options, preset, draft, review.settings.facts, loaded?.baseline);
    if (Object.keys(resolved.errors).length) return;
    setApplied(loaded ? Object.entries(resolved.values).map(([name, value]) => ({ name, value })) : resolved.overrides); setEditing(false); setOffset(0); setOffsets([]); next();
    setLoading(true); setRefresh(value => value + 1);
  }
  function next() {
    if (!name.trim()) setName(t("run_start.default_name", { preset: presetName ?? t(`run_start.preset.${preset}`), date: new Intl.DateTimeFormat().format(new Date()) }));
    setStep("review");
  }
  async function start() {
    if (!review || loading || working || review.blocked || engineId === null) return;
    setWorking(true); setFailure(null);
    try {
      const run = await api<RunView>("POST", `/api/projects/${projectId}/runs`, { engineId, preset, presetName, sourceRunId, name, importMode: review.importMode?.selected, revision: review.revision, ...(applied.length ? { options: applied } : {}) });
      window.location.hash = `#/runs/${run.id}`;
    } catch (error) { fail(error); } finally { setWorking(false); }
  }
  function chooseFile(file: SettingsFile, id: number | null) {
    pendingFile.current = { file, id }; switching.current = null;
    setLoaded({ file, id, baseline: [] }); setDropped([]); setDraft({}); setApplied([]); setMoved([]); setEditing(false);
    setPreset("custom"); setLoading(true); setOffset(0); setOffsets([]); setRefresh(value => value + 1);
  }
  const info = review?.engine.info;
  const resolved = review?.settings ? resolveSettings(review.settings.options, preset, draft, review.settings.facts, loaded?.baseline) : null;
  const file: SettingsFile | null = !loading && resolved && !Object.keys(resolved.errors).length ? {
    options: Object.entries(resolved.values).map(([name, value]) => ({ name, value })),
    preset: presetName ?? t(`run_start.preset.${preset}`), engineVersion: typeof info?.engineVersion === "string" ? info.engineVersion : null,
  } : null;
  const number = (value: number | null | undefined) => value == null ? t("run_start.not_reported") : String(value);
  const memory = (value: number | null | undefined) => value == null ? t("run_start.not_reported") : formatBytes(value);
  return <section aria-labelledby="run-start-title">
    <h2 id="run-start-title">{t("run_start.title")}</h2>
    {!open ? <Button onClick={() => setOpen(true)}>{t("run_start.choose")}</Button> : <>
      <Select id="run-engine" label={t("run_start.engine")} value={engineId ?? ""} onChange={event => changeEngine(Number(event.target.value))} disabled={working || editing}>
        {!engines.length && <option value="">{t("run_start.no_engines")}</option>}
        {engines.map(engine => <option key={engine.id} value={engine.id}>{engine.name}</option>)}
      </Select>
      {loading && <p role="status">{t("run_start.loading")}</p>}
      {!editing && step === "review" && review?.importMode && <ImportChoice value={{ ...review.importMode, selected: importMode ?? review.importMode.selected }} disabled={working || loading} onChange={mode => { setLoading(true); setOffset(0); setOffsets([]); setImportMode(mode); }} />}
      {failure && <ErrorMessage failure={failure} />}
      {changed && <><p role="alert">{t("run_start.changed")}</p><Button onClick={() => { setOffsets([]); setOffset(0); }}>{t("run_start.reload")}</Button></>}
      {editing && review?.settings && !loading && <SettingsEditor options={review.settings.options} preset={preset} draft={draft} baselineOptions={loaded?.baseline} facts={review.settings.facts} onChange={setDraft} onApply={applySettings} onCancel={() => { setDraft(editorBefore.current); setEditing(false); }} disabled={working} />}
      {!editing && <Button className="secondary" disabled={!review?.settings || loading || working} onClick={editSettings}>{t("run_settings.change")}</Button>}
      {review?.settings && <PresetLibrary key={`${projectId}-${engineId}`} file={file} selectedId={loaded?.id ?? null} disabled={working || loading} onChoose={chooseFile} onRename={(id, name) => { if (loaded?.id === id) setLoaded({ ...loaded, file: { ...loaded.file, preset: name } }); }} onDelete={id => { if (loaded?.id === id) setLoaded({ ...loaded, id: null }); }} onAuthRequired={onAuthRequired} />}
      {loaded && !loading && review?.settings && <section aria-label={t("run_presets.loaded", { name: loaded.file.preset })}>
        <h3>{t("run_presets.loaded", { name: loaded.file.preset })}</h3>
        {loaded.file.engineVersion !== (info?.engineVersion ?? null) && <p>{t("run_presets.version", { before: loaded.file.engineVersion ?? t("run_presets.unknown_version"), after: info?.engineVersion ?? t("run_presets.unknown_version") })}</p>}
        <OptionList options={planPreset("custom", review.settings.options, loaded.baseline).departures.map(option => ({ ...option, help: review.settings!.options.find(item => item.name === option.name)?.help ?? "", unexplained: review.settings!.options.find(item => item.name === option.name)?.unexplained ?? false }))} />
      </section>}
      {dropped.length > 0 && <section aria-label={t("run_presets.dropped")} aria-live="polite"><h3>{t("run_presets.dropped")}</h3><ul>{dropped.map(item => <li key={item.name}><code>{item.name}</code>{" "}{String(item.value)}<p>{t(`run_presets.drop.${item.reason}`)}</p></li>)}</ul></section>}
      {!editing && step === "preset" && <>
        <fieldset disabled={working}><legend>{t("run_start.presets")}</legend>
          {PRESET_IDS.map(id => <div key={id}><label><input type="radio" name="preset" value={id} checked={!loaded && preset === id} onChange={() => changePreset(id)} /> {t(`run_start.preset.${id}`)}</label>
            <p>{t(`run_start.description.${id}`)}</p>
            {review && !loading && <OptionList options={review.presets.find(item => item.id === id)?.departures ?? []} />}
          </div>)}
        </fieldset>
        <Button disabled={!review || loading || working} onClick={next}>{t("run_start.review")}</Button>
      </>}
      {!editing && step === "review" && review && !loading && <>
        <h3>{t("run_start.review")}</h3>
        <p>{t("run_start.project", { name: review.project.name })}</p>
        <TextField id="run-name" label={t("run_start.name")} value={name} onChange={event => setName(event.target.value)} required maxLength={200} />
        <p>{t("run_start.selected_preset", { preset: review.presetName ?? t(`run_start.preset.${review.preset}`) })}</p>
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
        {moved.length > 0 && <section aria-label={t("run_settings.moved")}><h4>{t("run_settings.moved")}</h4><ul>{moved.map(option => <li key={option.name}>
          <code>{option.name}</code>{" "}{t("run_settings.moved_value", { before: option.before === undefined ? t("run_settings.unavailable") : optionValue(option.before), after: option.after === undefined ? t("run_settings.unavailable") : optionValue(option.after) })}
          <p>{option.changes.map(change => t(change === "value" ? "run_settings.moved_value_reason" : `run_settings.moved_${change}`)).join(" ")}</p>
        </li>)}</ul></section>}
        {review.engine.kind === "local" && review.engine.gpu === false && review.settings?.matcherWarning && <aside role="alert"><p>{t("run_settings.gpu_warning")}</p><blockquote>{review.settings.matcherWarning}</blockquote></aside>}
        <h4>{t("run_start.changed_options")}</h4><OptionList options={review.options} />
        <h4>{t("run_start.outputs")}</h4><ul>{review.outputs.map(output => <li key={output}>{t(`run_start.output.${output}`)}</li>)}</ul>
        <h4>{t("run_start.always_requested")}</h4><p>{t("run_start.always_explain")}</p><ul>{review.alwaysProduced.map(output => <li key={output}>{t(`run_start.output.${output}`)}</li>)}</ul>
        {review.blocked && <ErrorMessage failure={new ApiFailure(0, review.blocked.code, review.blocked.data)} />}
        <Button className="secondary" disabled={working} onClick={reloadReview}>{t("run_start.reload")}</Button>{" "}
        <Button className="secondary" disabled={working} onClick={() => setStep("preset")}>{t("run_start.back")}</Button>{" "}
        <Button disabled={working || !!review.blocked || !name.trim()} onClick={() => void start()}>{t("run_start.start")}</Button>
      </>}
    </>}
  </section>;
}
