import type { ReactNode } from "react";
import type { Route } from "../router.ts";
import { t } from "../i18n/translate.ts";

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  return (
    <>
      <header className="app-header">
        <span className="app-name">{t("app.name")}</span>
        <nav aria-label={t("nav.label")}>
          <a href="#/" aria-current={route === "home" ? "page" : undefined}>
            {t("nav.home")}
          </a>
          <a href="#/engines" aria-current={route === "engines" ? "page" : undefined}>
            {t("nav.engines")}
          </a>
          <a href="#/sample" aria-current={route === "sample" ? "page" : undefined}>
            {t("nav.sample")}
          </a>
          <a href="#/settings" aria-current={route === "settings" ? "page" : undefined}>
            {t("nav.settings")}
          </a>
        </nav>
      </header>
      <main>{children}</main>
    </>
  );
}
