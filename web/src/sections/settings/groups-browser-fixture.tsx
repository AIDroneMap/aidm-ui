import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OPTION_CATALOGUE, type PresetId } from "../../../../shared/option-catalogue.ts";
import type { SettingsDraft } from "../../../../shared/run-settings.ts";
import { reconcileOptions } from "../../../../server/options/reconcile.ts";
import { SettingsWorkspace } from "./SettingsWorkspace.tsx";
import "../../styles.css";

const engine = OPTION_CATALOGUE.map((option) => option.bin === "shown"
  ? { name: option.name, type: option.type, value: String(option.defaultValue), domain: typeof option.domain === "string" ? option.domain : [...option.domain], help: `Engine help for ${option.name}. Default: %(default)s` }
  : { name: option.name, type: "bool" as const, value: "false", domain: "", help: "Hidden" });
const options = reconcileOptions([...engine, { name: "future-option", type: "string", value: "", domain: "string", help: "<img src=x onerror=alert(1)> & engine help" }]);

/** The workspace on its own, with every catalogue option and one the catalogue does not know. */
function Fixture() {
  const [draft, setDraft] = useState<SettingsDraft>({});
  const [preset, setPreset] = useState<PresetId>("custom");
  const [reviews, setReviews] = useState(0);
  return <>
    <SettingsWorkspace options={options} facts={{ bands: null, videos: null }} preset={preset} loadedName={null} draft={draft} onDraft={setDraft} onPreset={(value) => { setPreset(value); setDraft({}); }} engine={null} presets={null} busy={false} disabled={false} onReview={() => setReviews((count) => count + 1)} />
    <output id="reviews">{reviews}</output>
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
