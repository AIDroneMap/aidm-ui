import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import recorded from "../../../../test-support/fixtures/task-api-2.7.0-options.json";
import type { EngineOption } from "../../../../shared/engine-options.ts";
import { LOST_OUTPUTS, WARNING_CODES, type WarningContext } from "../../../../shared/option-warnings.ts";
import type { SettingsDraft } from "../../../../shared/run-settings.ts";
import { reconcileOptions } from "../../../../server/options/reconcile.ts";
import en from "../../i18n/en.json";
import { SettingsEditor } from "../../run-settings/SettingsEditor.tsx";

const messages: Record<string, string> = en;
const options = reconcileOptions(recorded as EngineOption[]);
/** The words of a warning as a row shows them, with the plain names filled in. */
const said = (key: string) => messages[key]!.replace("{skip3d}", messages["option.skip-3dmodel.name"]!).replace("{classify}", messages["option.pc-classify.name"]!);
const cpu: WarningContext = { engine: { kind: "local", gpu: false, cpuCores: 4 }, photoCount: 50 };

function render(draft: SettingsDraft, context?: WarningContext) {
  return renderToStaticMarkup(<SettingsEditor options={options} preset="custom" draft={draft} facts={{ bands: false, videos: false }} warningContext={context} onChange={() => {}} onApply={() => {}} onCancel={() => {}} />);
}

/** The markup of the row whose engine flag is the given name. */
function row(html: string, name: string): string {
  const rows = html.split('<div class="settings-editor-row');
  const found = rows.find((part) => part.includes(`<code>${name}</code>`));
  if (!found) throw new Error(`No row for ${name}`);
  return found;
}

test("every warning has its words under the warn prefix and nothing else is there", () => {
  const expected = [...WARNING_CODES, ...LOST_OUTPUTS.map((output) => `warn.lost.${output}`)];
  for (const key of expected) expect(messages[key]?.trim(), key).toBeTruthy();
  expect(Object.keys(messages).filter((key) => key.startsWith("warn.") && key !== "warn.title").sort()).toEqual(expected.sort());
  expect(messages["warn.processes_over_cores"]).toContain("{cores}");
  expect(messages["warn.end_with"]).toContain("{stage}");
});

test("no warning gives a speed or memory figure, even one from the engine's help", () => {
  const figure = /times as long|times longer|\bfactor\b|\b(two|three|four|five|ten) times\b|\d\s*(x|gb|mb|%)(?![a-z])/i;
  const found = Object.entries(messages).filter(([key, text]) => key.startsWith("warn.") && figure.test(text)).map(([key]) => key);
  expect(found).toEqual([]);
  expect(figure.test("takes roughly four times as long")).toBe(true);
  expect(figure.test("~1GB per thread")).toBe(true);
});

test("a warning names other options by their plain names", () => {
  const html = row(render({ "fast-orthophoto": true, dtm: true }), "fast-orthophoto");
  expect(html).toContain(said("warn.fast_orthophoto"));
  expect(html).toContain(messages["option.skip-3dmodel.name"]!);
  expect(row(render({ dtm: true }), "dtm")).toContain(said("warn.ground_classifies"));
  expect(render({ "fast-orthophoto": true, dtm: true })).not.toContain("{skip3d}");
});

test("a warning shows under its row as the value is set and goes when the combination goes", () => {
  const before = render({ "use-3dmesh": true });
  expect(row(before, "use-3dmesh")).not.toContain(said("warn.mesh_makes_model"));
  const set = render({ "use-3dmesh": true, "skip-3dmodel": true });
  for (const name of ["use-3dmesh", "skip-3dmodel"]) {
    expect(row(set, name)).toContain(said("warn.mesh_makes_model"));
    expect(row(set, name)).toMatch(/aria-describedby="[^"]*-warnings"/);
  }
  expect(row(set, "dsm")).not.toContain(said("warn.mesh_makes_model"));
  expect(set.split(said("warn.mesh_makes_model"))).toHaveLength(3);
  expect(render({ "use-3dmesh": true, "skip-3dmodel": false })).not.toContain(said("warn.mesh_makes_model"));
});

test("the facts of the run reach the rules that need them", () => {
  expect(row(render({ "matcher-type": "hamming", "max-concurrency": 6, split: 20 }, cpu), "matcher-type")).toContain(messages["warn.hamming_cpu"]!);
  expect(row(render({ "max-concurrency": 6 }, cpu), "max-concurrency")).toContain(messages["warn.processes_over_cores"]!.replace("{cores}", "4"));
  expect(row(render({ split: 20 }, cpu), "split")).toContain(messages["warn.split"]!);
  const unknown = render({ "matcher-type": "hamming", "max-concurrency": 6, split: 20 });
  for (const code of ["warn.hamming_cpu", "warn.split"] as const) expect(unknown).not.toContain(messages[code]!);
  expect(unknown).not.toContain("more processes than");
});

test("the stop stage names the stage and lists what the run will not make", () => {
  const html = row(render({ "end-with": "odm_orthophoto" }), "end-with");
  expect(html).toContain(messages["warn.end_with"]!.replace("{stage}", messages["run.stage.odm_orthophoto.name"]!).replaceAll('"', "&quot;"));
  expect(html).toContain(`<li>${messages["warn.lost.report"]}</li><li>${messages["warn.lost.viewer-model"]}</li>`);
  expect(html).not.toContain(`<li>${messages["warn.lost.orthophoto"]}</li>`);
});

test("warnings never block: with notices showing, Apply stays enabled", () => {
  const html = render({ "fast-orthophoto": true, "ignore-gsd": true, "sfm-algorithm": "planar", "optimize-disk-space": true, "use-exif": true }, cpu);
  expect(html.match(/class="notice notice-warn"/g)?.length).toBeGreaterThanOrEqual(5);
  expect(html).toMatch(/<button[^>]*>Apply/);
  expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Apply/);
});
