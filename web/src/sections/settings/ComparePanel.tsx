import { useEffect, useRef } from "react";
import type { ReconciledOption } from "../../../../shared/engine-options.ts";
import type { SettingsDraft } from "../../../../shared/run-settings.ts";
import { Button } from "../../controls/Button.tsx";
import { DiffPanel } from "../../controls/DiffPanel.tsx";
import { IconButton } from "../../controls/IconButton.tsx";
import { SegmentedControl } from "../../controls/SegmentedControl.tsx";
import { IconX } from "../../icons/icons.tsx";
import { t } from "../../i18n/translate.ts";
import { nameOf, valueText } from "./SettingsGroups.tsx";
import { compareRows, resetRow, type CompareMode, type Resolved } from "./settings-view.ts";

type Props = {
  mode: CompareMode;
  onMode: (mode: CompareMode) => void;
  /** The preset the run started from, a built-in one or a saved one. */
  presetName: string;
  options: readonly ReconciledOption[];
  draft: SettingsDraft;
  resolved: Resolved;
  disabled: boolean;
  onChange: (draft: SettingsDraft) => void;
  onClose: () => void;
};

/**
 * Beside the settings: every option that differs from the engine's defaults,
 * or from the preset the run started from, with this run's value and a reset
 * per row. Takes the focus when it opens; Escape closes it.
 */
export function ComparePanel({ mode, onMode, presetName, options, draft, resolved, disabled, onChange, onClose }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  // A reset takes its row, and the focused button, away: the focus goes back to the panel's heading.
  const keepFocus = () => requestAnimationFrame(() => { if (!heading.current?.closest("aside")?.contains(document.activeElement)) heading.current?.focus(); });
  const rows = compareRows(mode, options, draft, resolved);
  const byName = new Map(options.map((option) => [option.name, option]));
  const defaults = mode === "defaults";
  return <aside id="settings-compare" className="settings-compare" aria-labelledby="settings-compare-title" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
    <header className="settings-compare-header">
      <h3 id="settings-compare-title" ref={heading} tabIndex={-1}>{t("settings.compare.title")}</h3>
      <IconButton label={t("settings.compare.close")} icon={<IconX />} onClick={onClose} />
    </header>
    <SegmentedControl name="settings-compare-mode" legend={t("settings.compare.mode")} value={mode} onChange={onMode} options={[
      { value: "defaults", label: t("settings.compare.defaults") },
      { value: "preset", label: t("settings.compare.preset", { name: presetName }) },
    ]} />
    <DiffPanel
      label={defaults ? t("settings.compare.defaults") : t("settings.compare.preset", { name: presetName })}
      columns={{ name: t("settings.compare.option"), from: t(defaults ? "settings.compare.default_column" : "settings.compare.preset_column"), to: t("settings.compare.value_column") }}
      rows={rows.map((row) => {
        const option = byName.get(row.name)!;
        return { id: row.name, name: nameOf(option), code: row.name, from: valueText(row.reference), to: valueText(row.value), resetLabel: t(defaults ? "settings.compare.reset_default" : "settings.compare.reset_preset", { name: nameOf(option) }) };
      })}
      onReset={disabled ? undefined : (name) => { onChange(resetRow(mode, byName.get(name)!, draft, resolved)); keepFocus(); }}
      empty={t(defaults ? "settings.compare.none_defaults" : "settings.compare.none_preset")}
    />
    <Button variant="secondary" disabled={disabled || Object.keys(draft).length === 0} onClick={() => { onChange({}); keepFocus(); }}>{t("settings.compare.back")}</Button>
  </aside>;
}
