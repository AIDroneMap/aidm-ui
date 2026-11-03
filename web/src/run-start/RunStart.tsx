import { useEffect, useRef, useState } from "react";
import type { RunSeed } from "../../../shared/run-management.ts";
import type { EngineView, RunView } from "../../../shared/api-types.ts";
import { rebaseSettings, resolveSettings, type MovedSetting, type SettingsDraft } from "../../../shared/run-settings.ts";
import type { ReconciledOption } from "../../../shared/engine-options.ts";
import { PresetLibrary } from "../run-settings/PresetLibrary.tsx";
import { reconcileSettingsFile, type SettingsFile, type SettingValue, type DroppedSetting } from "../../../shared/settings-file.ts";
import { SettingsWorkspace } from "../sections/settings/SettingsWorkspace.tsx";
import { ReviewPlaceholder, ReviewScreen } from "../sections/review/ReviewSection.tsx";
import { optionWarnings } from "../../../shared/option-warnings.ts";
import type { PresetId } from "../../../shared/option-catalogue.ts";
import type { ImportMode, ReviewOption, RunReviewView } from "../../../shared/run-review.ts";
import { api, asApiFailure, ApiFailure } from "../api.ts";
import { ErrorMessage } from "../components/ErrorMessage.tsx";
import { Button } from "../controls/Button.tsx";
import { Select } from "../controls/Select.tsx";
import { formatBytes } from "../format.ts";
import { t } from "../i18n/translate.ts";

function optionValue(value: ReviewOption["value"]): string {
  return typeof value === "boolean" ? t(value ? "run_start.yes" : "run_start.no") : String(value);
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

export type RunStartStep = "settings" | "review";

/**
 * Starts a run: the settings workspace first, then the review and the start.
 * In the project's workspace the address chooses the step (`step` and
 * `onStep`), so Settings and Review are two sections over one draft, and
 * `filterInAddress` keeps "Changed only" in the address. Elsewhere, as for
 * "Run again", the steps follow each other in place.
 */
export function RunStart({ projectId, sourceRunId, filterInAddress = false, step: shownStep, onStep, onAuthRequired }: { projectId: number; sourceRunId?: number; filterInAddress?: boolean; step?: RunStartStep; onStep?(step: RunStartStep): void; onAuthRequired(): void }) {
  const [importMode, setImportMode] = useState<ImportMode | undefined>();
  const [draft, setDraft] = useState<SettingsDraft>({});
  const [applied, setApplied] = useState<Array<{ name: string; value: ReviewOption["value"] }>>([]);
  const [loaded, setLoaded] = useState<{ file: SettingsFile; id: number | null; baseline: SettingValue[] } | null>(null);
  const [dropped, setDropped] = useState<DroppedSetting[]>([]);
  const pendingFile = useRef<{ file: SettingsFile; id: number | null } | null>(null);
  const presetName = loaded?.file.preset;
  const [moved, setMoved] = useState<MovedSetting[]>([]);
  const switching = useRef<{ options: ReconciledOption[]; draft: SettingsDraft; baseline?: SettingValue[] } | null>(null);
  const settingsKey = JSON.stringify(applied);
  const [engines, setEngines] = useState<EngineView[]>([]);
  const [engineId, setEngineId] = useState<number | null>(null);
  const [preset, setPreset] = useState<PresetId>("quick-map");
  const [review, setReview] = useState<RunReviewView | null>(null);
  // The last review, kept on screen while the next one loads, as after a change of engine or import mode.
  const lastReview = useRef<RunReviewView | null>(null);
  if (review) lastReview.current = review;
  const [ownStep, setOwnStep] = useState<RunStartStep>("settings");
  const step = shownStep ?? ownStep;
  const goTo = (next: RunStartStep) => { if (onStep) onStep(next); else setOwnStep(next); };
  // True once "Review and start" took the draft; any later change to it needs that press again.
  const [reviewed, setReviewed] = useState(false);
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
    setImportMode(undefined); setDraft({}); setApplied([]); setMoved([]); switching.current = null; setLoaded(null); setDropped([]); pendingFile.current = null; setReviewed(false);
  }, [projectId]);
  useEffect(() => {
    let current = true;
    Promise.all([api<EngineView[]>("GET", "/api/engines"), sourceRunId === undefined ? Promise.resolve(null) : api<RunSeed>("GET", `/api/runs/${sourceRunId}/settings`)]).then(([value, seed]) => {
      if (!current) return;
      const available = value.filter(engine => engine.enabled);
      setEngines(available); setEngineId(available.find(engine => engine.id === seed?.engineId)?.id ?? available[0]?.id ?? null);
      if (seed) {
        chooseFile({ options: seed.options, preset: seed.presetName ?? t(`run_start.preset.${seed.preset ?? "custom"}`), engineVersion: null }, null);
        setName(seed.name ?? "");
      }
    }, error => { if (current) fail(error); });
    return () => { current = false; };
  }, [projectId, sourceRunId]);
  useEffect(() => {
    if (engineId === null) return;
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
      if (value.facts && value.facts.pendingMetadata > 0) timer = setTimeout(() => setRefresh(value => value + 1), 300);
    }, error => { if (current === generation.current) { setReview(null); setLoading(false); fail(error); } });
    return () => { generation.current++; clearTimeout(timer); };
  }, [projectId, engineId, preset, offset, refresh, settingsKey, presetName, sourceRunId, importMode]);
  function changeDraft(value: SettingsDraft) { setReviewed(false); setDraft(value); }
  function changePreset(value: PresetId) {
    setReviewed(false); setDraft({}); setApplied([]); setMoved([]); switching.current = null; setLoaded(null); setDropped([]); pendingFile.current = null;
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
  /** "Review and start": the draft becomes the run's settings, checked again by the server, and the review opens. */
  function applySettings() {
    if (!review) return;
    if (!review.settings) { next(); return; }
    const resolved = resolveSettings(review.settings.options, preset, draft, review.settings.facts, loaded?.baseline);
    if (Object.keys(resolved.errors).length) return;
    setApplied(loaded ? Object.entries(resolved.values).map(([name, value]) => ({ name, value })) : resolved.overrides); setOffset(0); setOffsets([]); next();
    setLoading(true); setRefresh(value => value + 1);
  }
  function next() {
    if (!name.trim()) setName(t("run_start.default_name", { preset: presetName ?? t(`run_start.preset.${preset}`), date: new Intl.DateTimeFormat().format(new Date()) }));
    setReviewed(true); goTo("review");
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
    setReviewed(false); pendingFile.current = { file, id }; switching.current = null;
    setLoaded({ file, id, baseline: [] }); setDropped([]); setDraft({}); setApplied([]); setMoved([]);
    setPreset("custom"); setLoading(true); setReview(null); setOffset(0); setOffsets([]); setRefresh(value => value + 1);
  }
  const info = review?.engine.info;
  const resolved = review?.settings ? resolveSettings(review.settings.options, preset, draft, review.settings.facts, loaded?.baseline) : null;
  const file: SettingsFile | null = !loading && resolved && !Object.keys(resolved.errors).length ? {
    options: Object.entries(resolved.values).map(([name, value]) => ({ name, value })),
    preset: presetName ?? t(`run_start.preset.${preset}`), engineVersion: typeof info?.engineVersion === "string" ? info.engineVersion : null,
  } : null;
  const shownReview = review ?? (loading ? lastReview.current : null);
  const warningContext = review ? { engine: { kind: review.engine.kind, gpu: review.engine.gpu, cpuCores: review.engine.info.cpuCores ?? null }, photoCount: review.photos.included } : undefined;
  const engineSelect = <Select id="run-engine" label={t("run_start.engine")} value={engineId ?? ""} onChange={event => changeEngine(Number(event.target.value))} disabled={working}>
    {!engines.length && <option value="">{t("run_start.no_engines")}</option>}
    {engines.map(engine => <option key={engine.id} value={engine.id}>{engine.name}</option>)}
  </Select>;
  const movedList = moved.length > 0 && <section aria-label={t("run_settings.moved")}><h4>{t("run_settings.moved")}</h4><ul>{moved.map(option => <li key={option.name}>
    <code>{option.name}</code>{" "}{t("run_settings.moved_value", { before: option.before === undefined ? t("run_settings.unavailable") : optionValue(option.before), after: option.after === undefined ? t("run_settings.unavailable") : optionValue(option.after) })}
    <p>{option.changes.map(change => t(change === "value" ? "run_settings.moved_value_reason" : `run_settings.moved_${change}`)).join(" ")}</p>
  </li>)}</ul></section>;
  return <section aria-labelledby="run-start-title" className={step === "settings" ? "settings-workspace-host" : "review-host"}>
    <h2 id="run-start-title" className={step === "settings" || onStep ? "visually-hidden" : undefined}>{t("run_start.title")}</h2>
    {failure && <ErrorMessage failure={failure} />}
    {changed && <><p role="alert">{t("run_start.changed")}</p><Button onClick={() => { setOffsets([]); setOffset(0); }}>{t("run_start.reload")}</Button></>}
    {step === "settings" && <SettingsWorkspace
      options={review?.settings?.options ?? null} facts={review?.settings?.facts ?? { bands: null, videos: null }}
      preset={preset} loadedName={loaded?.file.preset ?? null} baseline={loaded?.baseline}
      draft={draft} onDraft={changeDraft} onPreset={changePreset}
      engine={engineSelect}
      presets={engineId !== null && <PresetLibrary key={`${projectId}-${engineId}`} file={file} selectedId={loaded?.id ?? null} disabled={working || loading} onChoose={chooseFile} onRename={(id, name) => { if (loaded?.id === id) setLoaded({ ...loaded, file: { ...loaded.file, preset: name } }); }} onDelete={id => { if (loaded?.id === id) setLoaded({ ...loaded, id: null }); }} onAuthRequired={onAuthRequired} />}
      notices={<>
        {loaded && !loading && review?.settings && <section aria-label={t("run_presets.loaded", { name: loaded.file.preset })}>
          <h3>{t("run_presets.loaded", { name: loaded.file.preset })}</h3>
          {loaded.file.engineVersion !== (info?.engineVersion ?? null) && <p>{t("run_presets.version", { before: loaded.file.engineVersion ?? t("run_presets.unknown_version"), after: info?.engineVersion ?? t("run_presets.unknown_version") })}</p>}
        </section>}
        {dropped.length > 0 && <section aria-label={t("run_presets.dropped")} aria-live="polite"><h3>{t("run_presets.dropped")}</h3><ul>{dropped.map(item => <li key={item.name}><code>{item.name}</code>{" "}{String(item.value)}<p>{t(`run_presets.drop.${item.reason}`)}</p></li>)}</ul></section>}
        {movedList}
      </>}
      projectId={filterInAddress ? projectId : undefined}
      warningContext={warningContext}
      busy={loading || !review} disabled={working} onReview={applySettings}
    />}
    {step === "review" && !reviewed && <ReviewPlaceholder projectId={projectId} />}
    {step === "review" && reviewed && loading && <p role="status">{t("run_start.loading")}</p>}
    {/* While the review reloads it stays on screen with its buttons off, so the focus stays where it was. */}
    {step === "review" && reviewed && shownReview && <ReviewScreen
      review={shownReview} engineState={engines.find(engine => engine.id === shownReview.engine.id)?.state ?? null}
      name={name} onName={setName} engine={engineSelect}
      importChoice={shownReview.importMode && <ImportChoice value={{ ...shownReview.importMode, selected: importMode ?? shownReview.importMode.selected }} disabled={working || loading} onChange={mode => { setLoading(true); setOffset(0); setOffsets([]); setImportMode(mode); }} />}
      flightPages={shownReview.facts && <>
        {offsets.length > 0 && <Button className="secondary" onClick={() => { setLoading(true); setOffset(offsets[offsets.length - 1]!); setOffsets(offsets.slice(0, -1)); }}>{t("upload.previous")}</Button>}
        {shownReview.facts.nextOffset !== null && <Button className="secondary" onClick={() => { setLoading(true); setOffsets([...offsets, offset]); setOffset(shownReview.facts!.nextOffset!); }}>{t("upload.next")}</Button>}
      </>}
      moved={movedList}
      warnings={review?.settings && resolved && warningContext ? optionWarnings(review.settings.options, resolved.values, warningContext) : []}
      working={working || loading} onReload={reloadReview} onBack={() => goTo("settings")} onStart={() => void start()}
    />}
  </section>;
}
