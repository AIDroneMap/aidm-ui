import type { ReactNode } from "react";
import { IconSearch, IconX } from "../icons/icons.tsx";
import { t } from "../i18n/translate.ts";
import { IconButton } from "./IconButton.tsx";

type Props = {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** How many things match, said under the field and to screen readers. Leave out while there is no search. */
  matches?: number;
  placeholder?: string;
};

/** A search box with a clear button. Escape clears it too. */
export function SearchField({ id, label, value, onChange, matches, placeholder }: Props) {
  return (
    <div className="field search-field">
      <label htmlFor={id}>{label}</label>
      <div className="search-field-box">
        <IconSearch />
        <input
          id={id}
          type="search"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-count`}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && value) { event.preventDefault(); onChange(""); } }}
        />
        {value ? <IconButton label={t("ui.search.clear")} icon={<IconX />} onClick={() => onChange("")} /> : null}
      </div>
      <p id={`${id}-count`} className="field-hint" aria-live="polite">
        {value && matches !== undefined ? t(matches === 1 ? "ui.search.matches_one" : "ui.search.matches_other", { count: matches }) : ""}
      </p>
    </div>
  );
}
