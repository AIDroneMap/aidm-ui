import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PRESET_IDS } from "../../../../shared/option-catalogue.ts";
import type { RunReviewView } from "../../../../shared/run-review.ts";
import texts from "../../i18n/en.json";
import { ReviewScreen } from "./ReviewSection.tsx";

const words = texts as Record<string, string>;

const view: RunReviewView = {
  project: { id: 1, name: "Vineyard north" },
  engine: { id: 2, name: "Field engine", kind: "remote", info: { version: "2.7.0", engineVersion: "0.2.0", cpuCores: 8, totalMemory: null, availableMemory: null, queueCount: 0, maxParallelTasks: null }, gpu: null, imageLimit: null, imageLimitReported: true },
  preset: "quick-map", presets: PRESET_IDS.map((id) => ({ id, departures: [] })),
  wayIn: "upload", photos: { included: 312, excluded: 4, total: 316, bytes: 2048 }, facts: null,
  options: [
    { name: "fast-orthophoto", value: true, defaultValue: false, help: "", unexplained: false },
    { name: "max-concurrency", value: 2, defaultValue: 8, help: "", unexplained: false },
    { name: "new-option", value: 4, defaultValue: 2, help: "Engine help", unexplained: true },
  ],
  serverSet: [{ name: "tiles", value: true, defaultValue: false, help: "", unexplained: false }],
  outputs: ["orthophoto", "report"], alwaysProduced: ["pc-ept", "cog", "gltf"], revision: "r", blocked: null,
};

function render(review: RunReviewView, name = "Quick map 3/11/2026") {
  return renderToStaticMarkup(<ReviewScreen
    review={review} engineState="ready" name={name} onName={() => {}} engine={null} importChoice={null} flightPages={null} moved={null}
    warnings={[{ code: "warn.fast_orthophoto", options: ["fast-orthophoto"] }]} working={false} onReload={() => {}} onBack={() => {}} onStart={() => {}}
  />);
}

test("Review lists what goes in, the engine, the run name, what comes out, every changed option and the warnings", () => {
  const html = render(view);
  for (const text of [words["review.processed"]!, words["engine.state.ready"]!, words["review.outputs"]!, words["run_start.output.orthophoto"]!, words["review.server_set"]!, words["review.warnings"]!]) expect(html).toContain(text);
  expect(html).toContain("Included: 312. Left out: 4. Total: 316.");
  expect(html).toContain("Engine: Field engine");
  expect(html).toContain('value="Quick map 3/11/2026"');
  // Plain name, the engine's flag and the value, for changed options and for those the server sets.
  expect(html).toContain(`<span class="review-option-name">${words["option.max-concurrency.name"]}</span> <code>max-concurrency</code> <span class="review-option-value">2</span>`);
  expect(html).toContain(`<span class="review-option-name">${words["option.tiles.name"]}</span> <code>tiles</code> <span class="review-option-value">${words["run_start.yes"]}</span>`);
  expect(html).toContain(words["warn.fast_orthophoto"]!.replace("{skip3d}", words["option.skip-3dmodel.name"]!));
  // The columns come before the start: outputs and options on the right, after what is processed.
  expect(html.indexOf(words["review.processed"]!)).toBeLessThan(html.indexOf(words["review.outputs"]!));
  expect(html.indexOf(words["review.warnings"]!)).toBeLessThan(html.indexOf(words["review.start"]!));
});

test("an option the catalogue does not know shows its engine name and help", () => {
  const html = render(view);
  expect(html).toContain('<span class="review-option-name">new-option</span>');
  expect(html).toContain(words["run_start.unexplained"]!.replace("{help}", "Engine help"));
});

test("a blocked start says why in a notice above the button and changes nothing else", () => {
  const open = render(view);
  const blocked = render({ ...view, blocked: { code: "project_run.image_limit", data: { count: 312, limit: 300 } } });
  const reason = words["project_run.image_limit"]!.replace("{count}", "312").replace("{limit}", "300");
  expect(open).not.toContain(reason);
  expect(blocked).toContain(reason);
  const notice = blocked.indexOf(reason), start = blocked.indexOf(words["review.start"]!);
  expect(notice).toBeLessThan(start);
  expect(blocked.slice(blocked.indexOf('<div class="review-start">'), start)).toContain(reason);
  // Take the notice and the disabled start away and the two screens are the same.
  const withoutNotice = blocked.replace(/<div role="alert" class="notice notice-warn review-blocked">.*?<\/div><\/div>/, "");
  expect(withoutNotice.replace(/<button type="button" disabled="">(?=Start the run)/, '<button type="button">')).toBe(open);
});

test("Start waits for a run name", () => {
  expect(render(view, "  ")).toMatch(/<button type="button" disabled="">Start the run<\/button>/);
  expect(render(view)).toMatch(/<button type="button">Start the run<\/button>/);
});
