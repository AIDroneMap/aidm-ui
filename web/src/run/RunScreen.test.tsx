import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunView } from "../../../shared/api-types.ts";
import { stagesOf } from "../../../shared/run-stages.ts";
import { RunProgress, type RunProgressProps } from "../components/RunProgress.tsx";
import { formatClock } from "../format.ts";
import { t } from "../i18n/translate.ts";
import { linesWithRestart } from "../runs.ts";
import { untranslatedText } from "../test-helpers.ts";
import { RunLog } from "./RunLog.tsx";

const base: RunView = {
  id: 12, projectId: 3, name: "North field", preset: "quick-map", wayIn: "upload", sample: false, engineId: 1, engineName: "Barn engine", engineLocal: false,
  state: "processing", step: null, download: null, upload: null, progress: 45, engineMessage: null, problem: null, restarted: false, restartedAtLine: null,
  resultsAvailable: false, createdAt: new Date(Date.now() - 600_000).toISOString(), processingTime: 95_000, stages: [], failure: null,
};
const seenAt = "2026-11-02T10:04:00.000Z";

function render(view: Partial<RunView>, props: Partial<RunProgressProps> = {}): string {
  return renderToStaticMarkup(
    <RunProgress run={{ ...base, ...view }} lines={[]} connectionLost={false} cancelling={false} failure={null} onCancel={() => {}} level={1} {...props} />,
  );
}

test("the header names the run, its engine, its state and the engine's processing time", () => {
  const html = render({});
  expect(html).toContain("<h1 tabindex=\"-1\">North field</h1>");
  expect(html).toContain("Running on &quot;Barn engine&quot;");
  expect(html).toContain("The engine is processing the images");
  expect(html).toContain("status-running");
  expect(html).toContain("Processing for 1 min 35 s");
  expect(html).toContain("Cancel the run");
  expect(render({ state: "completed", processingTime: 754_000 })).toContain("Processed in 12 min 34 s");
});

test("before the engine reports a processing time the header counts from the run's creation", () => {
  const html = render({ state: "queued", processingTime: null, createdAt: new Date(Date.now() - 150_000).toISOString() });
  expect(html).toMatch(/Started 2 min (29|30|31) s ago/);
  expect(html).not.toContain("Processing for");
  // A run that ended before the engine processed it has no elapsed time to show.
  const failed = render({ state: "failed", processingTime: null });
  expect(failed).not.toContain("Started");
  expect(failed).not.toContain("Processed in");
});

test("a run with no name is called by its number, and the heading level follows the screen it sits in", () => {
  expect(render({ name: null })).toContain(">Run 12</h1>");
  expect(render({}, { level: 2 })).toContain("<h2 tabindex=\"-1\">North field</h2>");
  expect(render({}, { level: 2 })).not.toContain("<h1");
});

test("the stage list shows every stage with its state, the time it was seen to start, and the current one's progress and description", () => {
  const stages = stagesOf([{ name: "dataset", line: 0, at: seenAt }, { name: "opensfm", line: 4, at: seenAt }], null, "processing");
  const html = render({ stages });
  expect(html).toContain('aria-label="Stages"');
  expect(html).toContain("Prepare photos");
  expect(html).toContain("Match photos and locate cameras");
  expect(html).toContain("The engine matches features in the photos and estimates camera positions.");
  expect(html).toContain("Processing: 45%");
  expect(html).toContain('aria-current="step"');
  expect(html).toContain(`<time dateTime="${seenAt}">Started at ${formatClock(seenAt)}</time>`);
  expect(html.match(/<li class="stage stage-done"/g)?.length).toBe(1);
  expect(html.match(/<li class="stage stage-waiting"/g)?.length).toBe(9);
  // The bar sits on the current stage, not on its own.
  expect(html).not.toContain('id="run-processing"');
  expect(untranslatedText(html, ["North field", "Barn engine", formatClock(seenAt)])).toEqual([]);
});

test("a stage stopped by a cancellation says so", () => {
  const stages = stagesOf([{ name: "dataset", line: 0, at: seenAt }], null, "cancelled");
  expect(render({ state: "cancelled", stages })).toContain("Stopped before it finished.");
});

test("a failed run comes first with its stage, the engine's message and the last lines, the first error marked", () => {
  const stages = stagesOf([{ name: "dataset", line: 0, at: seenAt }, { name: "opensfm", line: 1, at: seenAt }], null, "failed");
  const lines = ["[INFO]    Running dataset stage", "[INFO]    Running opensfm stage", "matching", "[ERROR]   Out of memory", "Traceback (most recent call last):"];
  const html = render(
    { state: "failed", engineMessage: "Process exited with code 1", stages, failure: { stage: "opensfm", from: 1, to: 5, errorLine: 3 } },
    { lines, actions: <button type="button">Retry</button> },
  );
  expect(html).toContain("The run failed at this stage: Match photos and locate cameras");
  expect(html).toContain("The engine said: Process exited with code 1");
  expect(html).toContain("The last 4 lines of the log:");
  expect(html).toContain('<mark class="run-log-line"><span class="visually-hidden">First error:</span>[ERROR]   Out of memory</mark>');
  expect(html).not.toContain(">[INFO]    Running dataset stage</span>");
  expect(html).toContain("Show the whole log");
  expect(html.indexOf("The run failed")).toBeLessThan(html.indexOf("Retry"));
  expect(html.indexOf("Retry")).toBeLessThan(html.indexOf('aria-label="Stages"'));
  expect(html.indexOf('aria-label="Stages"')).toBeLessThan(html.indexOf("Engine log (5 lines)"));
});

test("a failure with no stage and no error line still names what happened", () => {
  const html = render({ state: "failed", problem: { code: "run.upload_failed", data: {} }, failure: { stage: null, from: 0, to: 0, errorLine: null } });
  expect(html).toContain("The run failed</h2>");
  expect(html).toContain("AIDM UI could not send the images to the engine.");
  expect(html).not.toContain("The last");
});

test("a finished run shows the Results section's viewer tiles and downloads before its stages", () => {
  const stages = stagesOf([{ name: "dataset", line: 0, at: seenAt }], null, "completed");
  const outputs = [{ name: "glb", size: 512 }, { name: "orthophoto", size: 1024 }];
  const html = render({ state: "completed", stages, resultsAvailable: true, results: { state: "ready", archiveSize: 2048, outputs } });
  expect(html).toContain('aria-label="Results"');
  expect(html).toContain('<a class="viewer-tile" href="#/projects/3/results/12/map">');
  expect(html).toContain('<a class="viewer-tile" href="#/projects/3/results/12/model">');
  // The whole archive first, then each output by name with its size.
  const downloads = [...html.matchAll(/<a href="(\/api\/runs\/12\/[^"]+)" download="">/g)].map((match) => match[1]);
  expect(downloads).toEqual(["/api/runs/12/results", "/api/runs/12/outputs/orthophoto", "/api/runs/12/outputs/glb"]);
  expect(html).toContain("Delete the results of this run");
  expect(html.indexOf('class="viewer-tile"')).toBeLessThan(html.indexOf('aria-label="Stages"'));
  expect(html.indexOf("/api/runs/12/results")).toBeLessThan(html.indexOf('aria-label="Stages"'));
  expect(html).not.toContain("Cancel the run");
  expect(untranslatedText(html, ["North field", "Barn engine"])).toEqual([]);
});

test("a run without an orthophoto or a model has no viewer tile, only its downloads", () => {
  const html = render({ state: "completed", results: { state: "ready", archiveSize: 2048, outputs: [{ name: "report", size: 100 }] } });
  expect(html).not.toContain("viewer-tile");
  expect(html).toContain('href="/api/runs/12/outputs/report"');
});

test("results that could not be fetched offer a retry, and deleted results say so", () => {
  const failed = render({ state: "completed", results: { state: "failed", archiveSize: null, outputs: [] } });
  expect(failed).toContain("Could not fetch results.");
  expect(failed).toContain(">Try fetching results again</button>");
  const deleted = render({ state: "completed", results: { state: "deleted", archiveSize: null, outputs: [] } });
  expect(deleted).toContain("Results deleted.");
  expect(deleted).not.toContain("/outputs/");
  expect(render({ state: "completed" })).toContain("This run has no results yet.");
});

test("while the results are fetched the band shows the fetch going on", () => {
  const html = render({ state: "completed", step: "results", results: { state: "fetching", archiveSize: null, outputs: [] } });
  expect(html).toContain('id="run-results-fetching"');
  expect(html).toContain("Fetching results");
});

test("an engine that does not answer is a warning that says what to check", () => {
  const html = render({ state: "engine_unreachable" });
  expect(html).toContain("The engine is not answering");
  expect(html).toContain("Check that the engine&#x27;s computer is on and connected to the network.");
});

test("the log is folded behind its line count, counting the lines the page dropped", () => {
  const html = render({}, { lines: ["one", "two"], lineCount: 12431 });
  expect(html).toContain("Engine log (12,431 lines)");
  expect(html).not.toContain("<pre");
});

test("the open log is a labelled, focusable region with copy and save", () => {
  const html = renderToStaticMarkup(<RunLog runId={12} lines={["line one", "line two"]} count={2} open onToggle={() => {}} />);
  expect(html).toMatch(/<details[^>]*open=""/);
  expect(html).toMatch(/<pre[^>]*role="region"[^>]*aria-label="Engine log"[^>]*tabindex="0"/);
  expect(html).toContain("line one\nline two");
  expect(html).toContain(">Copy</button>");
  expect(html).toContain(">Save as file</button>");
  expect(renderToStaticMarkup(<RunLog runId={12} lines={[]} count={0} open onToggle={() => {}} />)).toContain("Nothing has been logged yet.");
});

test("the open log shows a separator, in the interface's words, where the engine's output began again", () => {
  const lines = linesWithRestart({ lines: ["old one", "old two", "new one"], count: 3 }, 2, t("run.log_restarted"));
  const html = renderToStaticMarkup(<RunLog runId={12} lines={lines} count={3} open onToggle={() => {}} />);
  expect(html).toContain("old one\nold two\nThe engine restarted here. The lines below are from its new start.\nnew one");
  expect(untranslatedText(html, ["old one\nold two\nThe engine restarted here. The lines below are from its new start.\nnew one"])).toEqual([]);
});
