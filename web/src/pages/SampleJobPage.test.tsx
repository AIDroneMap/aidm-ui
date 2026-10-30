import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../api.ts";
import {
  RUN_STATES,
  type RunView,
  type SampleEngineOffer,
  type SampleView,
} from "../../../shared/api-types.ts";
import en from "../i18n/en.json";
import { untranslatedText, unlabelledInputs } from "../test-helpers.ts";
import { RunProgress, SampleIntro, SampleJobPage, type RunProgressProps, type SampleIntroProps } from "./SampleJobPage.tsx";

const offered: SampleEngineOffer = {
  engineId: 1,
  engineName: "Barn engine",
  local: false,
  offered: true,
  memoryCap: 16 * 1024 ** 3,
  reason: null,
};

const sample: SampleView = {
  dataset: {
    name: "Small vineyard",
    licence: "CC BY 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "Photos by A. Pilot",
    imageCount: 73,
    size: 888735308,
  },
  reference: { architecture: "x86-64", seconds: 1366, cores: 4, memoryGiB: 15 },
  peakMemory: 7360806912,
  engines: [offered],
  run: null,
};

const introData = ["Small vineyard", "CC BY 4.0", "Photos by A. Pilot", "73", "848 MiB", "Barn engine", "Small laptop"];

function renderIntro(view: SampleView = sample, overrides: Partial<SampleIntroProps> = {}): string {
  return renderToStaticMarkup(
    <SampleIntro
      sample={view}
      engineId={view.engines.find((engine) => engine.offered)?.engineId ?? null}
      onEngineChange={() => {}}
      starting={false}
      failure={null}
      onStart={() => {}}
      {...overrides}
    />,
  );
}

const run: RunView = {
  name: null, preset: null, wayIn: null, sample: false,
  id: 7,
  projectId: 1,
  engineId: 1,
  engineName: "Barn engine",
  engineLocal: false,
  state: "created",
  step: null,
  download: null,
  upload: null,
  progress: null,
  engineMessage: null,
  problem: null,
  restarted: false,
  restartedAtLine: null,
  resultsAvailable: false,
  createdAt: "2026-10-26T10:00:00Z",
};

const runData = ["Barn engine", "line one\nline two"];

function renderRun(view: Partial<RunView>, overrides: Partial<RunProgressProps> = {}): string {
  return renderToStaticMarkup(
    <RunProgress
      stage={null}
      run={{ ...run, ...view }}
      lines={["line one", "line two"]}
      connectionLost={false}
      cancelling={false}
      failure={null}
      onCancel={() => {}}
      onAgain={() => {}}
      {...overrides}
    />,
  );
}

test("before a run the photos, licence, image count and download size are shown", () => {
  const html = renderIntro();
  expect(html).toContain("Small vineyard");
  expect(html).toContain('<a href="https://creativecommons.org/licenses/by/4.0/"');
  expect(html).toContain(">CC BY 4.0</a>");
  expect(html).toContain("Photos by A. Pilot");
  expect(html).toContain(">73<");
  expect(html).toContain("848 MiB");
  expect(untranslatedText(html, introData)).toEqual([]);
  expect(unlabelledInputs(html)).toEqual([]);
});

test("the reference time is labelled as a measurement on a test machine", () => {
  const html = renderIntro();
  expect(html).toContain(
    "Measured on a 4-core test machine with 15 GiB of memory (x86-64): 22 min 46 s. Your computer may be faster or slower.",
  );
});

test("an arm64 reference reads with its own label and time", () => {
  const html = renderIntro({ ...sample, reference: { architecture: "arm64", seconds: 982, cores: 4, memoryGiB: 15 } });
  expect(html).toContain("(arm64): 16 min 22 s");
});

test("without a reference the page says nothing was measured", () => {
  const html = renderIntro({ ...sample, reference: null });
  expect(html).toContain("No time was measured for this kind of computer");
  expect(html).not.toContain("22 min");
  expect(untranslatedText(html, introData)).toEqual([]);
});

test("the measured peak memory is shown", () => {
  expect(renderIntro()).toContain("the sample job used up to 6.9 GiB of memory");
});

test("the engine choice is a labelled list with a start button and a skip link", () => {
  const html = renderIntro();
  expect(html).toContain('<label for="sample-engine">Engine</label>');
  expect(html).toContain('<select id="sample-engine"');
  expect(html).toContain(">Barn engine</option>");
  expect(html).toContain("It is 848 MiB.");
  expect(html).toContain("Download the photos and start");
  expect(html).toContain('<a href="#/">Skip the sample job</a>');
});

test("the engine on this computer is named by the interface, whatever name the server stored for it", () => {
  const here: SampleEngineOffer = { ...offered, engineId: 3, engineName: "Nom enregistre", local: true };
  const refused: SampleEngineOffer = {
    ...here,
    engineId: 4,
    offered: false,
    memoryCap: 4 * 1024 ** 3,
    reason: { code: "sample.memory_below_peak", data: {} },
  };
  const html = renderIntro({ ...sample, engines: [here] });
  expect(html).toContain(">This computer</option>");
  expect(html).not.toContain("Nom enregistre");
  const listed = renderIntro({ ...sample, engines: [offered, refused] });
  expect(listed).toContain("<strong>This computer</strong>");
  expect(listed).not.toContain("Nom enregistre");
});

test("a run on the engine on this computer says so in the interface's words", () => {
  const html = renderRun({ engineLocal: true, engineName: "Nom enregistre" });
  expect(html).toContain("Running on this computer");
  expect(html).not.toContain("Nom enregistre");
});

test("a run on a remote engine puts the engine's name in quotes", () => {
  expect(renderRun({ engineLocal: false, engineName: "Barn engine" })).toContain("Running on &quot;Barn engine&quot;");
});

test("inside the wizard the sample job page leaves out the skip link, and its intro is said once", () => {
  const inWizard = renderIntro(sample, { showSkip: false });
  expect(inWizard).not.toContain("Skip the sample job");
  expect(inWizard.split(en["sample.intro"]).length - 1).toBe(1);
  expect(renderIntro()).toContain('<a href="#/">Skip the sample job</a>');
});

test("an engine that is not offered is listed with its cap and the peak", () => {
  const small: SampleEngineOffer = {
    engineId: 2,
    engineName: "Small laptop",
    local: false,
    offered: false,
    memoryCap: 4 * 1024 ** 3,
    reason: { code: "sample.memory_below_peak", data: {} },
  };
  const html = renderIntro({ ...sample, engines: [offered, small] });
  expect(html).toContain("Small laptop");
  expect(html).toContain("This engine may use 4.0 GiB of memory. The sample job needs more than 6.9 GiB.");
  expect(html).not.toContain(">Small laptop</option>");
  expect(untranslatedText(html, introData)).toEqual([]);
});

test("with no engine offered there is no start button and a link to the engines page", () => {
  const small: SampleEngineOffer = {
    engineId: 2,
    engineName: "Small laptop",
    local: false,
    offered: false,
    memoryCap: null,
    reason: { code: "sample.memory_unknown", data: {} },
  };
  const html = renderIntro({ ...sample, engines: [small] });
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<select");
  expect(html).toContain("No engine can run the sample job yet.");
  expect(html).toContain('<a href="#/engines">');
  expect(html).toContain('<a href="#/">Skip the sample job</a>');
  expect(untranslatedText(html, introData)).toEqual([]);
});

test("a refused start shows its problem", () => {
  const html = renderIntro(sample, { failure: new ApiFailure(409, "sample.already_running") });
  expect(html).toContain('role="alert"');
  expect(html).toContain("A sample job is already running.");
});

test("every run state has words", () => {
  for (const state of RUN_STATES) {
    const html = renderRun({ state });
    expect(untranslatedText(html, runData), state).toEqual([]);
    expect(html, state).toContain('<p role="status" class="run-state">');
    expect(html, state).not.toContain("run.state.");
  }
  expect(renderRun({ state: "engine_unreachable" })).toContain("The engine is not answering");
  expect(renderRun({ state: "unknown" })).toContain("The engine reported a status AIDM UI does not know");
});

test("the download step says what it downloads, then the bar, then the bytes and the speed", () => {
  const html = renderRun({
    step: "download",
    download: { received: 312 * 1024 ** 2, total: 888735308, speed: 3 * 1024 ** 2, retries: 0, lastRetry: null },
  });
  expect(html).toContain('<label for="run-download">Downloading the sample photos</label>');
  expect(html).not.toContain("Downloading the sample photos:");
  expect(html).toMatch(/<progress id="run-download" max="888735308" value="327155712"/);
  expect(html).toContain("<p>312 MiB of 848 MiB, 3 MiB per second</p>");
  expect(html).not.toContain("Interruptions");
  expect(html.indexOf("Downloading the sample photos")).toBeLessThan(html.indexOf("<progress"));
  expect(html.indexOf("<progress")).toBeLessThan(html.indexOf("312 MiB of 848 MiB"));
  expect(untranslatedText(html, runData)).toEqual([]);
});

test("the download step names no speed before there is one, and says why the connection last broke", () => {
  const html = renderRun({
    step: "download",
    download: {
      received: 100 * 1024 ** 2,
      total: 888735308,
      speed: null,
      retries: 2,
      lastRetry: { code: "download.connection_interrupted", data: {} },
    },
  });
  expect(html).toContain("<p>100 MiB of 848 MiB</p>");
  expect(html).not.toContain("per second");
  expect(html).toContain("The connection was interrupted. The download continues from where it stopped. Interruptions so far: 2.");
  expect(html.indexOf("100 MiB of 848 MiB")).toBeLessThan(html.indexOf("Interruptions so far"));
});

test("the upload step shows images done of total", () => {
  const html = renderRun({ state: "uploading", step: "upload", upload: { done: 12, total: 73 } });
  expect(html).toContain("Sending images: 12 of 73");
  expect(html).toContain('<label for="run-upload">');
});

test("processing shows the engine's progress as a percentage", () => {
  const html = renderRun({ state: "processing", progress: 45 });
  expect(html).toContain("Processing: 45%");
  expect(html).toContain('<label for="run-processing">');
});

test("the log is a labelled, focusable region", () => {
  const html = renderRun({ state: "processing" });
  expect(html).toContain('<h3 id="run-log-title">Log</h3>');
  expect(html).toMatch(/<pre[^>]*aria-labelledby="run-log-title"/);
  expect(html).toMatch(/<pre[^>]*tabindex="0"/);
  expect(html).toContain("line one\nline two");
});

test("an empty log says so", () => {
  expect(renderRun({}, { lines: [] })).toContain("Nothing has been logged yet.");
});

test("a run in progress can be cancelled", () => {
  expect(renderRun({ state: "processing" })).toContain("Cancel the run");
  expect(renderRun({ state: "engine_unreachable" })).toContain("Cancel the run");
});

test("a finished run cannot be cancelled but can be started again", () => {
  for (const state of ["completed", "failed", "cancelled"] as const) {
    const html = renderRun({ state });
    expect(html, state).not.toContain("Cancel the run");
    expect(html, state).toContain("Start again");
  }
});

test("a failed run shows the engine's own message", () => {
  const html = renderRun({ state: "failed", engineMessage: "Out of memory" });
  expect(html).toContain("The engine said: Out of memory");
});

test("a failed run shows its problem", () => {
  const html = renderRun({ state: "failed", problem: { code: "run.upload_failed", data: {} } });
  expect(html).toContain("AIDM UI could not send the images to the engine.");
});

test("a restarted run says so", () => {
  expect(renderRun({ state: "queued", restarted: true })).toContain("The engine restarted, so this run started over.");
  expect(renderRun({ state: "queued" })).not.toContain("started over");
});

test("the log shows a separator, in the interface's words, where the engine's output began again", () => {
  const html = renderRun(
    { state: "queued", restarted: true },
    { lines: ["old one", "old two", "new one"], lineCount: 3, restartedAtLine: 2 },
  );
  expect(html).toContain("old one\nold two\nThe engine restarted here. The lines below are from its new start.\nnew one");
  // A run that did not restart has no separator.
  expect(renderRun({ state: "processing" }, { restartedAtLine: null })).not.toContain("restarted here");
  expect(
    untranslatedText(html, [
      "Barn engine",
      "old one\nold two\nThe engine restarted here. The lines below are from its new start.\nnew one",
    ]),
  ).toEqual([]);
});

test("a completed run offers the results", () => {
  const html = renderRun({ state: "completed", resultsAvailable: true });
  expect(html).toContain('<a href="/api/runs/7/results" download="">Download the results</a>');
  expect(untranslatedText(html, runData)).toEqual([]);
});

test("a completed run whose results are not ready offers no link", () => {
  const html = renderRun({ state: "completed", resultsAvailable: false });
  expect(html).not.toContain("/results");
  expect(html).toContain("The results are being prepared.");
});

test("a lost live connection is announced while the run is going", () => {
  expect(renderRun({ state: "processing" }, { connectionLost: true })).toContain("Live updates are paused.");
  expect(renderRun({ state: "completed" }, { connectionLost: true })).not.toContain("Live updates are paused.");
});

test("every button in a run has a name", () => {
  for (const state of RUN_STATES) {
    const html = renderRun({ state });
    for (const match of html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)) {
      expect((match[1] ?? "").replace(/<[^>]*>/g, "").trim(), state).not.toBe("");
    }
  }
});

test("the page has its own heading, and leaves it out when it sits inside a screen that has one", () => {
  const alone = renderToStaticMarkup(<SampleJobPage onAuthRequired={() => {}} />);
  expect(alone).toContain("<h1>Sample job</h1>");
  const inside = renderToStaticMarkup(<SampleJobPage onAuthRequired={() => {}} embedded />);
  expect(inside).not.toContain("<h1");
  expect(inside).toContain("Loading the sample job...");
});

test("the run page explains the current stage", () => {
  const html = renderRun({ state: "processing" }, { stage: "odm_dem", lines: ["Running odm_dem stage"] });
  expect(html).toContain("Make elevation models");
  expect(html).toContain("surface and terrain models");
});

test("each engine stage is shown in translated words", () => {
  const stages = ["dataset", "split", "merge", "opensfm", "openmvs", "odm_filterpoints", "odm_meshing", "mvs_texturing", "odm_georeferencing", "odm_dem", "odm_orthophoto", "odm_report", "odm_postprocess"];
  const messages: Record<string, string> = en;
  for (const stage of stages) {
    const html = renderRun({ state: "processing" }, { stage: stage as RunProgressProps["stage"], lines: [`Running ${stage} stage`] });
    expect(html).toContain(messages[`run.stage.${stage}.name`]!);
    expect(html).toContain(messages[`run.stage.${stage}.description`]!);
  }
});

test("a restart clears the previous stage until a new stage starts", () => {
  const html = renderRun({ state: "processing", restarted: true }, { lines: ["Running odm_dem stage"], lineCount: 1, restartedAtLine: 1 });
  expect(html).not.toContain("Make elevation models");
});


test("sample titles are translated and operator names remain data", () => {
  const sampleHtml = renderRun({ name: "run.sample_name", sample: true });
  expect(sampleHtml).toContain(en["run.sample_name"]);
  expect(sampleHtml).not.toContain("run.sample_name");
  const customHtml = renderRun({ name: "North field", sample: false });
  expect(customHtml).toContain("North field");
});
