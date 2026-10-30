import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OPTION_CATALOGUE, type OptionValue } from "../../../shared/option-catalogue.ts";
import { reconcileOptions } from "../../../server/options/reconcile.ts";
import { SettingsEditor } from "./SettingsEditor.tsx";
import "../styles.css";

const engine = OPTION_CATALOGUE.map((option) => option.bin === "shown"
  ? { name: option.name, type: option.type, value: String(option.defaultValue), domain: typeof option.domain === "string" ? option.domain : [...option.domain], help: "Engine help" }
  : { name: option.name, type: "bool" as const, value: "false", domain: "", help: "Hidden" });
const options = reconcileOptions([...engine, { name: "future-option", type: "string", value: "", domain: "string", help: "<img src=x onerror=alert(1)> & engine help" }]);

function Fixture() {
  const [draft, setDraft] = useState<Record<string, OptionValue>>({});
  const [applied, setApplied] = useState(0);
  return <><SettingsEditor options={options} preset="custom" draft={draft} facts={{ bands: null, videos: null }} onChange={setDraft} onApply={() => setApplied((count) => count + 1)} onCancel={() => {}} /><output id="applied">{applied}</output></>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
