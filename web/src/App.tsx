import { t } from "./i18n/translate.ts";

export function App() {
  return (
    <main>
      <h1>{t("home.title")}</h1>
      <p>{t("home.body")}</p>
    </main>
  );
}
