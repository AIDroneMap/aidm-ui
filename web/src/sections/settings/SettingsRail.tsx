import type { ReactNode } from "react";
import { Button } from "../../controls/Button.tsx";
import { SearchField } from "../../controls/SearchField.tsx";
import { Toggle } from "../../controls/Toggle.tsx";
import { t } from "../../i18n/translate.ts";
import { groupId, groupLabel } from "./SettingsGroups.tsx";
import type { RowGroup } from "./settings-view.ts";

type Props = {
  search: string;
  onSearch: (value: string) => void;
  /** How many rows are on the page. */
  matches: number;
  changedOnly: boolean;
  onChangedOnly: (value: boolean) => void;
  groups: ReadonlyArray<{ group: RowGroup; changed: number; shown: boolean }>;
  active: RowGroup | null;
  onJump: (group: RowGroup) => void;
  compareOpen: boolean;
  onCompare: () => void;
  /** The saved presets, Save as preset, Import and Export. */
  presets: ReactNode;
};

/** The left rail of the settings: search, the filter, the groups with their changed counts, the comparison and the saved presets. */
export function SettingsRail({ search, onSearch, matches, changedOnly, onChangedOnly, groups, active, onJump, compareOpen, onCompare, presets }: Props) {
  return <div className="settings-rail">
    <SearchField id="settings-search" label={t("settings.search")} value={search} onChange={onSearch} matches={matches} />
    <Toggle id="settings-changed-only" label={t("settings.changed_only")} checked={changedOnly} onChange={(event) => onChangedOnly(event.currentTarget.checked)} />
    <nav aria-label={t("settings.rail")}>
      <ul className="settings-rail-groups">
        {groups.map(({ group, changed, shown }) => <li key={group}>
          <button type="button" className="settings-rail-group" aria-controls={groupId(group)} aria-current={active === group ? "true" : undefined} disabled={!shown} onClick={() => onJump(group)}>
            <span>{groupLabel(group)}</span>
            {changed > 0 && <span className="settings-rail-count"><span aria-hidden="true">{changed}</span><span className="visually-hidden">{t(changed === 1 ? "settings.rail_changed_one" : "settings.rail_changed_other", { count: changed })}</span></span>}
          </button>
        </li>)}
      </ul>
    </nav>
    <Button variant="secondary" id="settings-compare-open" aria-expanded={compareOpen} aria-controls={compareOpen ? "settings-compare" : undefined} onClick={onCompare}>{t("settings.compare.open")}</Button>
    <div className="settings-rail-presets">{presets}</div>
  </div>;
}
