import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import recorded from "../../../../test-support/fixtures/task-api-2.7.0-options.json";
import type { EngineOption, ReconciledOption } from "../../../../shared/engine-options.ts";
import type { PresetId } from "../../../../shared/option-catalogue.ts";
import type { SettingsDraft } from "../../../../shared/run-settings.ts";
import { reconcileOptions } from "../../../../server/options/reconcile.ts";
import texts from "../../i18n/en.json";
import { SettingsWorkspace } from "./SettingsWorkspace.tsx";

const words = texts as Record<string, string>;
/** Text as the markup holds it. */
const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");
const options = reconcileOptions(structuredClone(recorded) as EngineOption[]);

function render({ draft = {}, preset = "custom", list = options, facts = { bands: null, videos: null } }: { draft?: SettingsDraft; preset?: PresetId; list?: readonly ReconciledOption[]; facts?: { bands: boolean | null; videos: boolean | null } } = {}) {
  return renderToStaticMarkup(<SettingsWorkspace options={list} facts={facts} preset={preset} loadedName={null} draft={draft} onDraft={() => {}} onPreset={() => {}} engine={null} presets={null} busy={false} disabled={false} onReview={() => {}} />);
}

/** The markup of one option's row. */
function row(html: string, name: string): string {
  const start = html.indexOf(`data-option="${name}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('data-option="', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

test("the nine groups follow the run's order, each heading with its option count", () => {
  const html = render();
  expect([...html.matchAll(/<h3 id="settings-group-[^"]+-heading"[^>]*><span>([^<]+)<\/span><span class="settings-group-count" aria-hidden="true">(\d+)<\/span>/g)].map((match) => `${match[1]} ${match[2]}`)).toEqual([
    "Photos and cameras 16", "Matching and reconstruction 9", "Point cloud 9", "Mesh and texture 7", "Elevation models 6", "Orthophoto 8", "Outputs and formats 14", "Performance and limits 4", "Expert 7",
  ]);
  expect([...html.matchAll(/data-option="/g)]).toHaveLength(80);
});

test("a row shows its plain name, flag, control, sentence, affects chips, default and range, and the More texts with the engine's words", () => {
  const markup = row(render(), "orthophoto-resolution");
  for (const text of [words["option.orthophoto-resolution.name"], words["option.orthophoto-resolution.description"], "Default: 5. A number above 0.", ...["when", "cost", "example"].map((field) => words[`option.orthophoto-resolution.${field}`])]) {
    expect(markup).toContain(escaped(text!));
  }
  expect(markup).toContain('<code class="settings-flag">orthophoto-resolution</code>');
  expect(markup).toContain('<input id="setting-orthophoto-resolution"');
  expect(markup).toContain(`<figcaption>${escaped(words["settings.engine_words"]!)}</figcaption><blockquote>Orthophoto resolution in cm / pixel. Note that this value is capped by a ground sampling distance (GSD) estimate.Default: 5</blockquote>`);
  expect([...markup.matchAll(/<span class="chip">([^<]+)<\/span>/g)].map((match) => match[1])).toEqual(["Quality", "Orthophoto"]);
  expect(markup).not.toContain("settings-dot");
});

test("a value away from the engine default gets the changed dot, and so does a preset's own departure", () => {
  const html = render({ preset: "quick-map", draft: { dsm: true } });
  expect(row(html, "dsm")).toContain(`class="settings-dot" role="img" aria-label="${words["settings.dot"]}"`);
  expect(row(html, "fast-orthophoto")).toContain("settings-dot");
  expect(row(html, "dtm")).not.toContain("settings-dot");
  expect(html).toContain("2 options differ from the engine defaults.");
});

test("an invalid value marks its row and keeps Review and start disabled, with the reason beside it", () => {
  const html = render({ draft: { "orthophoto-resolution": "bad" } });
  expect(row(html, "orthophoto-resolution")).toContain('aria-invalid="true"');
  expect(row(html, "orthophoto-resolution")).toContain(words["run_settings.error.type"]!);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="settings-review-reason"[^>]*>Review and start<\/button><p id="settings-review-reason"[^>]*>Correct these settings first: Orthophoto resolution\.<\/p>/);
  expect(render()).toMatch(/<button(?![^>]*disabled)[^>]*>Review and start<\/button>/);
});

test("a locked option shows its reason, cannot be edited and shows on", () => {
  const markup = row(render(), "cog");
  expect(markup).toMatch(/<input id="setting-cog" type="checkbox" role="switch" disabled=""[^>]* checked=""/);
  expect(markup).toContain(words["settings.locked.always-on"]!);
  expect(markup).not.toContain("settings-row-facts");
});

test("a dependent option is disabled with its reason, and unknown photo facts say so", () => {
  const html = render({ draft: { "rolling-shutter-readout": "bad" }, facts: { bands: null, videos: null } });
  expect(row(html, "rolling-shutter-readout")).toContain("Requires Correct rolling shutter to be true.");
  expect(row(html, "rolling-shutter-readout")).toContain('value="bad"');
  expect(row(html, "radiometric-calibration")).toContain("Photo facts are unknown");
});

test("the expert group opens folded behind its notice, and opens itself when one of its options is changed", () => {
  const folded = render();
  expect(folded).toContain(words["settings.expert_notice"]!);
  expect(folded).toMatch(/<details class="settings-fold"><summary>Show the expert settings<\/summary>/);
  expect(render({ draft: { "end-with": "odm_dem" } })).toMatch(/<details class="settings-fold" open=""><summary>/);
});

test("an option the catalogue does not explain shows the engine's help as text and keeps its value types", () => {
  const extra: ReconciledOption = { name: "new-option", bin: "shown", group: "unexplained", type: "enum", domain: [1, "1", true], defaultValue: 1, presets: {}, dependencies: [], costTag: null, affects: [], locked: null, unexplained: true, changes: ["domain"], help: "<img src=x>" };
  const html = render({ list: [extra], draft: { "new-option": "1" } });
  expect(html).toContain("This setting comes from the engine");
  expect(html).toContain("&lt;img src=x&gt;");
  expect(html).toContain('<option value="1" selected="">1</option>');
  expect(html).toContain("allowed values");
});

test("a warning sits under its row from the run's values, describes the row's control and never blocks Review and start", () => {
  const html = render({ draft: { "optimize-disk-space": true } });
  expect(row(html, "optimize-disk-space")).toMatch(/<input id="setting-optimize-disk-space"[^>]*aria-describedby="setting-optimize-disk-space-about setting-optimize-disk-space-warnings"/);
  expect(row(html, "optimize-disk-space")).toContain(escaped(words["warn.disk_space"]!));
  expect(html.split(escaped(words["warn.disk_space"]!))).toHaveLength(2);
  expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Review and start<\/button>/);
  expect(render()).not.toContain(escaped(words["warn.disk_space"]!));
});
