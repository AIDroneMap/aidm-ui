import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ReconciledOption } from "../../../../shared/engine-options.ts";
import { PRESET_IDS, type OptionValue, type PresetId } from "../../../../shared/option-catalogue.ts";
import { resolveSettings, type SettingsDraft, type SettingsFacts } from "../../../../shared/run-settings.ts";
import { Button } from "../../controls/Button.tsx";
import { ConfirmDialog } from "../../controls/ConfirmDialog.tsx";
import { Select } from "../../controls/Select.tsx";
import { t } from "../../i18n/translate.ts";
import { changedOnlyFromHash, settingsHash, useHash } from "../../router.ts";
import { ComparePanel } from "./ComparePanel.tsx";
import { optionWarnings, type WarningContext } from "../../../../shared/option-warnings.ts";
import { OptionWarnings } from "./OptionWarnings.tsx";
import { SettingsGroups, groupId, nameOf } from "./SettingsGroups.tsx";
import { SettingsRail } from "./SettingsRail.tsx";
import { changedCounts, changedFromDefault, changedFromPreset, invalidOptions, matchesSearch, type CompareMode, type RowGroup } from "./settings-view.ts";
import "./settings.css";

const UNKNOWN_CONTEXT: WarningContext = { engine: { kind: null, gpu: null, cpuCores: null }, photoCount: null };

/** A section's top edge within this distance of the window's top marks its group as the one being read. */
const ACTIVE_EDGE = 24;

export type SettingsWorkspaceProps = {
  /** The selected engine's options, or null while they load. */
  options: readonly ReconciledOption[] | null;
  facts: SettingsFacts;
  preset: PresetId;
  /** The name of the saved preset or settings file the run started from, when it did. */
  loadedName: string | null;
  baseline?: readonly { name: string; value: OptionValue }[];
  draft: SettingsDraft;
  onDraft: (draft: SettingsDraft) => void;
  onPreset: (preset: PresetId) => void;
  /** The engine selector, which sits next to the preset. */
  engine: ReactNode;
  /** The saved presets, which sit in the rail. */
  presets: ReactNode;
  /** What changed with the engine or a loaded file, above the groups. */
  notices?: ReactNode;
  /** Keeps "Changed only" in the address of this project's Settings, so a reload keeps it. */
  projectId?: number;
  /** While the review is checked or a run starts. */
  busy: boolean;
  disabled: boolean;
  /** The engine and photos of the run. A warning that needs a fact missing here stays silent. */
  warningContext?: WarningContext;
  onReview: () => void;
};

/**
 * The Settings section as a workspace: the preset, the engine and "Review and
 * start" on top; the rail with search, "Changed only", the groups and the
 * saved presets on the left; every option, group after group, in the middle;
 * the comparison beside them when it is open.
 */
export function SettingsWorkspace({ options, facts, preset, loadedName, baseline, draft, onDraft, onPreset, engine, presets, notices, projectId, busy, disabled, warningContext = UNKNOWN_CONTEXT, onReview }: SettingsWorkspaceProps) {
  const hash = useHash();
  const [search, setSearch] = useState("");
  const [localChangedOnly, setLocalChangedOnly] = useState(false);
  const changedOnly = projectId === undefined ? localChangedOnly : changedOnlyFromHash(hash);
  const [compare, setCompare] = useState<CompareMode | null>(null);
  const [replacing, setReplacing] = useState<PresetId | null>(null);
  const [active, setActive] = useState<RowGroup | null>(null);
  const groupsElement = useRef<HTMLDivElement>(null);

  const resolved = options ? resolveSettings(options, preset, draft, facts, baseline) : null;
  const visible = (option: ReconciledOption) => matchesSearch(option, search, t) && (!changedOnly || (resolved !== null && changedFromDefault(option, resolved)));
  const shown = options?.filter(visible) ?? [];
  const counts = resolved && options ? changedCounts(options, resolved) : new Map<RowGroup, number>();
  const changed = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const edits = options && resolved ? options.filter((option) => changedFromPreset(option, draft, resolved)).length : 0;
  const invalid = options && resolved ? invalidOptions(options, resolved) : [];
  // Warnings inform under their rows and never block "Review and start".
  const warnings = options && resolved ? optionWarnings(options, resolved.values, warningContext) : [];
  const warningsFor = (option: ReconciledOption) => {
    if (!warnings.some((warning) => warning.options.includes(option.name))) return null;
    const id = `setting-${option.name}-warnings`;
    return { id, node: <OptionWarnings id={id} option={option.name} warnings={warnings} /> };
  };
  const presetName = loadedName ?? t(`run_start.preset.${preset}`);
  const groups = [...new Set(options?.map((option) => option.group) ?? [])];

  // The group whose section reaches the top of the window is the one being read.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const sections = [...(groupsElement.current?.querySelectorAll<HTMLElement>(".settings-group") ?? [])];
      let current = (sections[0]?.dataset.group as RowGroup | undefined) ?? null;
      for (const section of sections) if (section.getBoundingClientRect().top <= ACTIVE_EDGE) current = section.dataset.group as RowGroup;
      setActive(current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, [options, search, changedOnly]);

  function jump(group: RowGroup) {
    document.getElementById(groupId(group))?.scrollIntoView({ block: "start" });
    document.getElementById(`${groupId(group)}-heading`)?.focus({ preventScroll: true });
    setActive(group);
  }
  function changeFilter(value: boolean) {
    if (projectId === undefined) setLocalChangedOnly(value);
    else window.location.replace(settingsHash(projectId, value));
  }
  function choosePreset(value: string) {
    if (!(PRESET_IDS as readonly string[]).includes(value)) return;
    if (edits > 0) setReplacing(value as PresetId); else onPreset(value as PresetId);
  }
  function closeCompare() {
    setCompare(null);
    document.getElementById("settings-compare-open")?.focus();
  }

  const reason = invalid.length > 0 ? t("settings.review_blocked", { names: invalid.map(nameOf).join(", ") }) : null;
  return <div className={`settings-workspace${compare ? " settings-workspace-comparing" : ""}`}>
    <div className="settings-toolbar">
      <Select id="settings-preset" label={t("settings.preset")} value={loadedName !== null ? "saved" : preset} disabled={disabled} onChange={(event) => choosePreset(event.currentTarget.value)}>
        {loadedName !== null && <option value="saved">{t("settings.preset_saved", { name: loadedName })}</option>}
        {PRESET_IDS.map((id) => <option key={id} value={id}>{t(`run_start.preset.${id}`)}</option>)}
      </Select>
      {engine}
      <div className="settings-review">
        <Button disabled={busy || disabled || invalid.length > 0} aria-describedby={reason ? "settings-review-reason" : undefined} onClick={onReview}>{t("settings.review")}</Button>
        {reason && <p id="settings-review-reason" className="settings-review-reason">{reason}</p>}
      </div>
    </div>
    <p className="settings-summary">
      {t("settings.intro")}{" "}
      {resolved && t(changed === 0 ? "settings.changed_none" : changed === 1 ? "settings.changed_one" : "settings.changed_other", { count: changed })}
    </p>
    {loadedName === null && <p className="settings-preset-description">{t(`run_start.description.${preset}`)}</p>}
    {notices}
    <div className="settings-layout">
      <SettingsRail
        search={search} onSearch={setSearch} matches={shown.length}
        changedOnly={changedOnly} onChangedOnly={changeFilter}
        groups={groups.map((group) => ({ group, changed: counts.get(group) ?? 0, shown: shown.some((option) => option.group === group) }))}
        active={active} onJump={jump}
        compareOpen={compare !== null} onCompare={() => setCompare(compare ? null : "defaults")}
        presets={presets}
      />
      <div className="settings-main" ref={groupsElement}>
        {!options || !resolved ? <p role="status">{t("settings.loading")}</p>
          : shown.length === 0 ? <p className="settings-empty">{t(search.trim() ? "settings.no_match" : "settings.none_changed")}</p>
          : <SettingsGroups options={options} draft={draft} resolved={resolved} facts={facts} visible={visible} filtering={changedOnly || Boolean(search.trim())} searching={Boolean(search.trim())} disabled={disabled} notes={warningsFor} onChange={onDraft} />}
      </div>
      {compare && options && resolved && <ComparePanel mode={compare} onMode={setCompare} presetName={presetName} options={options} draft={draft} resolved={resolved} disabled={disabled} onChange={onDraft} onClose={closeCompare} />}
    </div>
    <ConfirmDialog
      open={replacing !== null}
      title={t("settings.confirm.title")}
      confirmLabel={t("settings.confirm.replace", { preset: replacing ? t(`run_start.preset.${replacing}`) : "" })}
      cancelLabel={t("settings.confirm.keep")}
      onConfirm={() => { const next = replacing; setReplacing(null); if (next) onPreset(next); }}
      onCancel={() => setReplacing(null)}
    >
      <p>{t(edits === 1 ? "settings.confirm.body_one" : "settings.confirm.body_other", { preset: replacing ? t(`run_start.preset.${replacing}`) : "", count: edits })}</p>
    </ConfirmDialog>
  </div>;
}
