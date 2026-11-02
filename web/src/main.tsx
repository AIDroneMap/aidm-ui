import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { t } from "./i18n/translate.ts";
import { applyTheme, storedTheme } from "./preferences/theme.ts";
import "./styles.css";

document.title = t("app.name");
// Before the first paint, so a page fixed to dark never flashes light.
applyTheme(storedTheme());

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
