import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunView } from "../../../../shared/api-types.ts";
import { RunOutputs } from "./RunOutputs.tsx";

const MIB = 1024 ** 2;

function run(outputs: Array<{ name: string; size: number }>, state: "ready" | "fetching" | "failed" | "deleted" = "ready"): RunView {
  return {
    id: 7, projectId: 3, name: "North block", preset: null, wayIn: null, sample: false, engineId: 1, engineName: null, engineLocal: false,
    state: "completed", step: null, download: null, upload: null, progress: null, engineMessage: null, problem: null, restarted: false, restartedAtLine: null,
    resultsAvailable: state === "ready", results: { state, archiveSize: state === "ready" ? 250 * MIB : null, outputs }, createdAt: "2026-11-02T10:00:00Z",
  };
}

const everything = [
  { name: "report", size: 2 * MIB }, { name: "glb", size: 40 * MIB }, { name: "orthophoto", size: 15 * MIB }, { name: "point-cloud", size: 90 * MIB },
  { name: "ground", size: 3 * MIB }, { name: "textured-model", size: 60 * MIB }, { name: "surface", size: 4 * MIB },
];

/** The words of each element the selector names, in order, with tags removed. */
function texts(html: string, open: RegExp): string[] {
  return [...html.matchAll(open)].map((match) => match[1]!.replace(/<[^>]+>/g, "").trim());
}

test("a run with every output shows both viewer tiles with their sizes, then the archive and each output by name", () => {
  const html = renderToStaticMarkup(<RunOutputs run={run(everything)} />);
  expect(texts(html, /<a class="viewer-tile" href="([^"]+)"/g)).toEqual(["#/projects/3/results/7/map", "#/projects/3/results/7/model"]);
  expect(texts(html, /<span class="viewer-tile-sizes">(.*?)<\/span><\/a>/g)).toEqual(["Orthophoto: 15 MiBSurface model: 4 MiBGround model: 3 MiB", "3D model (GLB): 40 MiB"]);
  expect(texts(html, /<li><a [^>]*download="">(.*?)<\/a>/g)).toEqual(["All results (archive)", "Orthophoto", "Surface model", "Ground model", "Point cloud", "Textured model", "3D model (GLB)", "Report"]);
  expect(texts(html, /<span class="download-size">(.*?)<\/span>/g)).toEqual(["250 MiB", "15 MiB", "4 MiB", "3 MiB", "90 MiB", "60 MiB", "40 MiB", "2 MiB"]);
  expect(html).toContain('href="/api/runs/7/results"');
  expect(html).toContain('href="/api/runs/7/outputs/point-cloud"');
});

test("a viewer tile is hidden, not disabled, when the run made no orthophoto or no model", () => {
  const noModel = renderToStaticMarkup(<RunOutputs run={run(everything.filter((output) => output.name !== "glb"))} />);
  expect(texts(noModel, /<a class="viewer-tile" href="([^"]+)"/g)).toEqual(["#/projects/3/results/7/map"]);
  const noOrthophoto = renderToStaticMarkup(<RunOutputs run={run(everything.filter((output) => output.name !== "orthophoto"))} />);
  expect(texts(noOrthophoto, /<a class="viewer-tile" href="([^"]+)"/g)).toEqual(["#/projects/3/results/7/model"]);
  const neither = renderToStaticMarkup(<RunOutputs run={run([{ name: "report", size: MIB }])} />);
  expect(neither).not.toContain("viewer-tile");
  expect(texts(neither, /<li><a [^>]*download="">(.*?)<\/a>/g)).toEqual(["All results (archive)", "Report"]);
});

test("nothing shows before the archive is ready or after it is deleted", () => {
  for (const state of ["fetching", "failed", "deleted"] as const) expect(renderToStaticMarkup(<RunOutputs run={run([], state)} />)).toBe("");
});
