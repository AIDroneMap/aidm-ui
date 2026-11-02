import { useState } from "react";
import { SegmentedControl } from "../controls/SegmentedControl.tsx";
import { t } from "../i18n/translate.ts";
import { chooseTheme, storedTheme, THEMES, type Theme } from "./theme.ts";

/** Light, dark, or the device's own setting. The choice applies at once and stays in this browser. */
export function ThemePreference({ initial = storedTheme() }: { initial?: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  return (
    <section aria-labelledby="preferences-theme-title">
      <h2 id="preferences-theme-title">{t("preferences.theme.title")}</h2>
      <p>{t("preferences.theme.explain")}</p>
      <SegmentedControl
        name="preferences-theme"
        legend={t("preferences.theme.title")}
        hideLegend
        options={THEMES.map((value) => ({ value, label: t(`preferences.theme.${value}`) }))}
        value={theme}
        onChange={(value) => {
          chooseTheme(value);
          setTheme(value);
        }}
      />
    </section>
  );
}
