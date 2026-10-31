import { useId, useState } from "react";
import type { ReconciledOption } from "../../../shared/engine-options.ts";
import { OPTION_CATALOGUE, type OptionDependency, type OptionValue, type PresetId } from "../../../shared/option-catalogue.ts";
import { resolveSettings, type SettingsDraft, type SettingsFacts } from "../../../shared/run-settings.ts";
import { Button } from "../controls/Button.tsx";
import { Disclosure } from "../controls/Disclosure.tsx";
import { Select } from "../controls/Select.tsx";
import { TextField } from "../controls/TextField.tsx";
import { Toggle } from "../controls/Toggle.tsx";
import { t } from "../i18n/translate.ts";
import "./SettingsEditor.css";

export type SettingsEditorProps = {
  options: readonly ReconciledOption[];
  preset: PresetId;
  draft: SettingsDraft;
  facts: SettingsFacts;
  onChange: (draft: SettingsDraft) => void;
  onApply: () => void;
  onCancel: () => void;
  disabled?: boolean;
};

const groups = [...new Set(OPTION_CATALOGUE.flatMap((option) => option.bin === "shown" ? [option.group] : []))];
const fields = ["name", "description", "when", "cost", "example"] as const;
const nameOf = (option: ReconciledOption) => option.unexplained ? option.name : t(`option.${option.name}.name`);

function optionParents(dependency: OptionDependency): string[] {
  if (dependency.kind === "option") return [dependency.name];
  if (dependency.kind === "any") return dependency.alternatives.flatMap(optionParents);
  return [];
}

function reason(dependency: OptionDependency, options: readonly ReconciledOption[], facts: SettingsFacts): string {
  if (dependency.kind === "dataset") return facts[dependency.fact] === null
    ? t("run_settings.unknown_facts")
    : t(`run_settings.needs_${dependency.fact}`);
  if (dependency.kind === "any") return t("run_settings.needs_any", { alternatives: dependency.alternatives.map((item) => reason(item, options, facts)).join(t("run_settings.or")) });
  const parent = options.find((option) => option.name === dependency.name);
  return t("run_settings.needs_option", { name: parent ? nameOf(parent) : dependency.name, value: String(dependency.value) });
}

function Group({ label, initialOpen, searching, children }: { label: string; initialOpen: boolean; searching: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(initialOpen);
  return <Disclosure label={label} open={searching || open} onToggle={(event) => { if (!searching) setOpen(event.currentTarget.open); }}>{children}</Disclosure>;
}

export function SettingsEditor({ options, preset, draft, facts, onChange, onApply, onCancel, disabled = false }: SettingsEditorProps) {
  const [search, setSearch] = useState("");
  const id = useId();
  const resolved = resolveSettings(options, preset, draft, facts);
  const query = search.trim().toLocaleLowerCase();
  const matches = (option: ReconciledOption) => !query || [option.name, ...(option.unexplained ? [option.help ?? ""] : fields.map((field) => t(`option.${option.name}.${field}`)))].some((text) => text.toLocaleLowerCase().includes(query));
  const changed = options.filter((option) => Object.hasOwn(draft, option.name) && (Boolean(resolved.errors[option.name]) || resolved.values[option.name] !== resolved.baseline[option.name]));
  const reset = (name: string) => { const next = { ...draft }; delete next[name]; onChange(next); };
  const update = (name: string, value: OptionValue) => onChange({ ...draft, [name]: value });

  function row(option: ReconciledOption, nested = false) {
    const controlId = `${id}-${option.name}`;
    const error = resolved.errors[option.name];
    const blocked = resolved.disabled[option.name] ?? [];
    const describedBy = [error && `${controlId}-error`, blocked.length > 0 && `${controlId}-reason`].filter(Boolean).join(" ") || undefined;
    const value = Object.hasOwn(draft, option.name) ? draft[option.name] : resolved.values[option.name] ?? resolved.baseline[option.name];
    const common = { id: controlId, label: nameOf(option), disabled: disabled || blocked.length > 0, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy };
    const parents = option.dependencies.flatMap(optionParents).map((parent) => options.find((candidate) => candidate.name === parent)).filter((parent): parent is ReconciledOption => Boolean(parent && parent.group !== option.group));
    return <div className={`settings-editor-row${nested ? " settings-editor-row-nested" : ""}`} key={option.name}>
      {option.type === "bool" ? <Toggle {...common} checked={value === true} onChange={(event) => update(option.name, event.currentTarget.checked)} />
        : option.type === "enum" && Array.isArray(option.domain) ? <Select {...common} value={String(option.domain.findIndex((choice) => choice === value))} onChange={(event) => { const choice = (option.domain as Array<OptionValue>)[Number(event.currentTarget.value)]; if (choice !== undefined) update(option.name, choice); }}>
          {option.domain.findIndex((choice) => choice === value) < 0 && <option value="-1">{String(value ?? "")}</option>}
          {option.domain.map((choice, index) => <option key={index} value={String(index)}>{String(choice)}</option>)}
        </Select> : <TextField {...common} type="text" inputMode={option.type === "int" ? "numeric" : option.type === "float" ? "decimal" : undefined} value={String(value ?? "")} onChange={(event) => update(option.name, event.currentTarget.value)} />}
      <small><code>{option.name}</code></small>
      <p>{option.unexplained ? option.help : t(`option.${option.name}.description`)}</p>
      {parents.length > 0 && <p>{t("run_settings.related_to", { names: parents.map(nameOf).join(", ") })}</p>}
      {option.changes.length > 0 && <p>{t("run_settings.engine_changes", { changes: option.changes.map((change) => t(`run_settings.change.${change}`)).join(", ") })}</p>}
      {blocked.length > 0 && <p id={`${controlId}-reason`}>{blocked.map((dependency) => reason(dependency, options, facts)).join(" ")}</p>}
      {error && <p className="settings-editor-error" id={`${controlId}-error`}>{t(`run_settings.error.${error}`)}</p>}
      {!option.unexplained && <Disclosure label={t("run_settings.more")} open={query ? true : undefined}><dl>{(["when", "cost", "example"] as const).map((field) => <div key={field}><dt>{t(`run_settings.${field}`)}</dt><dd>{t(`option.${option.name}.${field}`)}</dd></div>)}</dl></Disclosure>}
    </div>;
  }

  return <section className="settings-editor" aria-label={t("run_settings.title")}>
    <TextField id={`${id}-search`} label={t("run_settings.search")} value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
    <section aria-label={t("run_settings.changed")}><h3>{t("run_settings.changed")}</h3>
      {changed.length === 0 ? <p>{t("run_settings.no_changes")}</p> : <><ul>{changed.map((option) => <li key={option.name}>{nameOf(option)}{" "}<code>{String(draft[option.name])}</code> <Button disabled={disabled} onClick={() => reset(option.name)} aria-label={t("run_settings.reset_one", { name: nameOf(option) })}>{t("run_settings.reset")}</Button></li>)}</ul><Button disabled={disabled} onClick={() => onChange({})}>{t("run_settings.reset_all")}</Button></>}
    </section>
    {[...groups, "unexplained"].map((group) => {
      const members = options.filter((option) => (option.unexplained ? "unexplained" : option.group) === group);
      const visible = members.filter(matches);
      if (!members.length || !visible.length) return null;
      const parentFor = (option: ReconciledOption) => option.dependencies.flatMap(optionParents).find((name) => name !== option.name && members.some((candidate) => candidate.name === name && candidate.dependencies.flatMap(optionParents).length === 0));
      const ordered = visible.filter((option) => !parentFor(option) || !visible.some((candidate) => candidate.name === parentFor(option))).flatMap((option) => [row(option), ...visible.filter((child) => parentFor(child) === option.name).map((child) => row(child, true))]);
      return <Group key={`${preset}-${group}`} label={group === "unexplained" ? t("catalogue.unexplained") : t(`group.${group}`)} initialOpen={members.some((option) => resolved.baseline[option.name] !== option.defaultValue)} searching={Boolean(query)}>{ordered}</Group>;
    })}
    <div className="settings-editor-actions"><Button disabled={disabled} onClick={onCancel}>{t("run_settings.cancel")}</Button><Button disabled={disabled || Object.keys(resolved.errors).length > 0} onClick={onApply}>{t("run_settings.apply")}</Button></div>
  </section>;
}
