import { useState, type ReactNode } from "react";
import type { ReconciledOption } from "../../../../shared/engine-options.ts";
import type { OptionDependency, OptionValue } from "../../../../shared/option-catalogue.ts";
import type { SettingsDraft, SettingsFacts } from "../../../../shared/run-settings.ts";
import { Chip } from "../../controls/Chip.tsx";
import { Disclosure } from "../../controls/Disclosure.tsx";
import { Notice } from "../../controls/Notice.tsx";
import { Select } from "../../controls/Select.tsx";
import { TextField } from "../../controls/TextField.tsx";
import { Toggle } from "../../controls/Toggle.tsx";
import { IconLock } from "../../icons/icons.tsx";
import { t } from "../../i18n/translate.ts";
import { changedFromDefault, engineWords, optionRange, shownValue, type Resolved, type RowGroup } from "./settings-view.ts";

export const nameOf = (option: ReconciledOption) => option.unexplained ? option.name : t(`option.${option.name}.name`);

/** A value in the operator's words: on and off for a switch, and a word for empty text. */
export function valueText(value: OptionValue | undefined): string {
  if (typeof value === "boolean") return t(value ? "settings.value.on" : "settings.value.off");
  if (value === undefined || value === "") return t("settings.value.empty");
  return String(value);
}

/** The id of a group's section, which the rail scrolls to. */
export const groupId = (group: RowGroup) => `settings-group-${group}`;
export const groupLabel = (group: RowGroup) => group === "unexplained" ? t("catalogue.unexplained") : t(`settings.group.${group}`);

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

type RowProps = {
  option: ReconciledOption;
  options: readonly ReconciledOption[];
  draft: SettingsDraft;
  resolved: Resolved;
  facts: SettingsFacts;
  disabled: boolean;
  searching: boolean;
  nested: boolean;
  note: RowNote | null;
  onChange: (name: string, value: OptionValue) => void;
};

/** Something said under one row, such as a warning, with the id its control is described by. */
export type RowNote = { id: string; node: ReactNode };

/** One option, as section 6.3 of the proposal lists it: name, flag, changed dot, control, one sentence, affects chips, default and range, and More. */
function OptionRow({ option, options, draft, resolved, facts, disabled, searching, nested, note, onChange }: RowProps) {
  const controlId = `setting-${option.name}`;
  const error = resolved.errors[option.name];
  const blocked = resolved.disabled[option.name] ?? [];
  const locked = option.locked;
  const describedBy = [`${controlId}-about`, error && `${controlId}-error`, (blocked.length > 0 || locked) && `${controlId}-reason`, note?.id].filter(Boolean).join(" ");
  // The task API turns a locked option on for every task, so its switch shows on whatever the engine's default says.
  const value = locked === "always-on" ? true : shownValue(option, draft, resolved);
  const common = { id: controlId, label: nameOf(option), disabled: disabled || blocked.length > 0 || locked !== null, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy };
  const changed = changedFromDefault(option, resolved);
  const range = optionRange(option.domain);
  const parents = option.dependencies.flatMap(optionParents).map((parent) => options.find((candidate) => candidate.name === parent)).filter((parent): parent is ReconciledOption => Boolean(parent && parent.group !== option.group));
  const control = option.type === "bool" ? <Toggle {...common} checked={value === true} onChange={(event) => onChange(option.name, event.currentTarget.checked)} />
    : option.type === "enum" && Array.isArray(option.domain) ? <Select {...common} value={String(option.domain.findIndex((choice) => choice === value))} onChange={(event) => { const choice = (option.domain as OptionValue[])[Number(event.currentTarget.value)]; if (choice !== undefined) onChange(option.name, choice); }}>
      {option.domain.findIndex((choice) => choice === value) < 0 && <option value="-1">{String(value ?? "")}</option>}
      {option.domain.map((choice, index) => <option key={index} value={String(index)}>{String(choice)}</option>)}
    </Select>
    : <TextField {...common} type="text" inputMode={option.type === "int" ? "numeric" : option.type === "float" ? "decimal" : undefined} value={String(value ?? "")} onChange={(event) => onChange(option.name, event.currentTarget.value)} />;
  return <div className={`settings-row${nested ? " settings-row-nested" : ""}${changed ? " settings-row-changed" : ""}`} data-option={option.name}>
    <div className="settings-row-head">
      {control}
      <code className="settings-flag">{option.name}</code>
      {changed && <span className="settings-dot" role="img" aria-label={t("settings.dot")} title={t("settings.dot")} />}
    </div>
    <div id={`${controlId}-about`}>
      <p className="settings-row-text">{option.unexplained ? option.help : t(`option.${option.name}.description`)}</p>
      {option.affects.length > 0 && <ul className="settings-affects" aria-label={t("affects.title")}>{option.affects.map((tag) => <li key={tag}><Chip>{t(`affects.${tag}`)}</Chip></li>)}</ul>}
      {locked === null && <p className="settings-row-facts">{t("settings.default", { value: valueText(option.defaultValue) })}{range && <>{" "}{t(range.key, range.data)}</>}</p>}
    </div>
    {parents.length > 0 && <p>{t("run_settings.related_to", { names: parents.map(nameOf).join(", ") })}</p>}
    {option.changes.length > 0 && <p>{t("run_settings.engine_changes", { changes: option.changes.map((change) => t(`run_settings.change.${change}`)).join(", ") })}</p>}
    {(locked || blocked.length > 0) && <p className="settings-row-reason" id={`${controlId}-reason`}>{locked && <IconLock />}{locked ? t(`settings.locked.${locked}`) : blocked.map((dependency) => reason(dependency, options, facts)).join(" ")}</p>}
    {error && <p className="settings-row-error" id={`${controlId}-error`}>{t(`run_settings.error.${error}`)}</p>}
    {note?.node}
    {!option.unexplained && <Disclosure className="settings-more" label={t("settings.more")} open={searching ? true : undefined}>
      <dl>{(["when", "cost", "example"] as const).map((field) => <div key={field}><dt>{t(`settings.${field}`)}</dt><dd>{t(`option.${option.name}.${field}`)}</dd></div>)}</dl>
      {option.help && <figure className="settings-engine-words"><figcaption>{t("settings.engine_words")}</figcaption><blockquote>{engineWords(option)}</blockquote></figure>}
    </Disclosure>}
  </div>;
}

/** The Expert group starts folded behind its notice, unless a search, the filter or a change in it needs it open. */
function Folded({ open, children }: { open: boolean; children: ReactNode }) {
  const [unfolded, setUnfolded] = useState(false);
  return <Disclosure className="settings-fold" label={t("settings.expert_show")} open={open || unfolded} onToggle={(event) => { if (!open) setUnfolded(event.currentTarget.open); }}>{children}</Disclosure>;
}

export type SettingsGroupsProps = {
  options: readonly ReconciledOption[];
  draft: SettingsDraft;
  resolved: Resolved;
  facts: SettingsFacts;
  /** The rows search and "Changed only" leave on the page. */
  visible: (option: ReconciledOption) => boolean;
  /** True while search or "Changed only" narrows the rows, which opens every folded part. */
  filtering: boolean;
  searching: boolean;
  disabled?: boolean;
  /** What to say under a row, or null for nothing. */
  notes?: (option: ReconciledOption) => RowNote | null;
  onChange: (draft: SettingsDraft) => void;
};

/** The groups in run order as one long page, each with a heading that stays at the top while its rows scroll. */
export function SettingsGroups({ options, draft, resolved, facts, visible, filtering, searching, disabled = false, notes, onChange }: SettingsGroupsProps) {
  const update = (name: string, value: OptionValue) => onChange({ ...draft, [name]: value });
  const groups = [...new Set(options.map((option) => option.group))];
  return <div className="settings-groups">
    {groups.map((group) => {
      const members = options.filter((option) => option.group === group);
      const shown = members.filter(visible);
      if (!shown.length) return null;
      const parentFor = (option: ReconciledOption) => option.dependencies.flatMap(optionParents).find((name) => name !== option.name && members.some((candidate) => candidate.name === name && candidate.dependencies.flatMap(optionParents).length === 0));
      const row = (option: ReconciledOption, nested: boolean) => <OptionRow key={option.name} option={option} options={options} draft={draft} resolved={resolved} facts={facts} disabled={disabled} searching={searching} nested={nested} note={notes?.(option) ?? null} onChange={update} />;
      const rows = shown.filter((option) => !parentFor(option) || !shown.some((candidate) => candidate.name === parentFor(option)))
        .flatMap((option) => [row(option, false), ...shown.filter((child) => parentFor(child) === option.name).map((child) => row(child, true))]);
      const headingId = `${groupId(group)}-heading`;
      return <section key={group} id={groupId(group)} className="settings-group" aria-labelledby={headingId} data-group={group}>
        <h3 id={headingId} className="settings-group-heading" tabIndex={-1}>
          <span>{groupLabel(group)}</span>
          <span className="settings-group-count" aria-hidden="true">{members.length}</span>
          <span className="visually-hidden">{t("settings.group_options", { count: members.length })}</span>
        </h3>
        {group === "expert" ? <>
          <Notice tone="warn" role="note">{t("settings.expert_notice")}</Notice>
          <Folded open={filtering || members.some((option) => changedFromDefault(option, resolved))}>{rows}</Folded>
        </> : rows}
      </section>;
    })}
  </div>;
}
