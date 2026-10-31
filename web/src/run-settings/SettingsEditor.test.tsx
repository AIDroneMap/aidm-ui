import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OPTION_CATALOGUE } from "../../../shared/option-catalogue.ts";
import type { ReconciledOption } from "../../../shared/engine-options.ts";
import { SettingsEditor } from "./SettingsEditor.tsx";

const options: ReconciledOption[] = OPTION_CATALOGUE.flatMap((option) => option.bin === "shown"
  ? [{ ...option, domain: typeof option.domain === "string" ? option.domain : [...option.domain], unexplained: false, changes: [] }]
  : []);

test("shows catalogue groups, preset changes, and invalid edits", () => {
  const html = renderToStaticMarkup(<SettingsEditor options={options} preset="quick-map" draft={{ "orthophoto-resolution": "bad" }} facts={{ bands: null, videos: null }} onChange={() => {}} onApply={() => {}} onCancel={() => {}} />);
  expect(html).toContain("What to produce");
  expect(html).toContain("Quick orthophoto");
  expect(html).toContain("bad");
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain("Photo facts are unknown");
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply/);
});

test("keeps invalid inactive settings visible and blocks apply", () => {
  const html = renderToStaticMarkup(<SettingsEditor options={options} preset="custom" draft={{ "rolling-shutter-readout": "bad" }} facts={{ bands: true, videos: true }} onChange={() => {}} onApply={() => {}} onCancel={() => {}} />);
  expect(html).toContain("Camera readout time");
  expect(html).toContain("Requires Correct rolling shutter to be true.");
  expect(html).toContain('value="bad"');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply/);
});

test("renders unexplained engine help as text and preserves enum value types", () => {
  const extra: ReconciledOption = { name: "new-option", bin: "shown", group: "unexplained", type: "enum", domain: [1, "1", true], defaultValue: 1, presets: {}, dependencies: [], costTag: null, unexplained: true, changes: ["domain"], help: "<img src=x>" };
  const html = renderToStaticMarkup(<SettingsEditor options={[extra]} preset="custom" draft={{ "new-option": "1" }} facts={{ bands: null, videos: null }} onChange={() => {}} onApply={() => {}} onCancel={() => {}} />);
  expect(html).toContain("This setting comes from the engine");
  expect(html).toContain("&lt;img src=x&gt;");
  expect(html).toContain('<option value="1" selected="">1</option>');
  expect(html).toContain("allowed values");
});
