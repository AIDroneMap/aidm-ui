import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MapPanel } from "./MapView.tsx";
import { t } from "../i18n/translate.ts";

function Fixture() {
  const [runId, setRunId] = useState("7");
  return <><button onClick={() => setRunId("8")}>{t("map.unavailable")}</button><button onClick={() => setRunId("9")}>{t("map.loading")}</button><button onClick={() => setRunId("7")}>{t("map.open")}</button><MapPanel key={runId} runId={runId} /></>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
