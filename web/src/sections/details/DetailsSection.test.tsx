import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectView } from "../../../../shared/api-types.ts";
import { DetailsForm, DetailsSection } from "./DetailsSection.tsx";
import { DeleteConfirmation } from "./DeleteConfirmation.tsx";
import { untranslatedText, unlabelledInputs } from "../../test-helpers.ts";

const project: ProjectView = { id: 4, name: "Field <survey>", notes: "notes", builtin: null, photoCount: 2, runCount: 1, latestState: "completed", lastChange: "2024-02-01T00:00:00.000Z" };
const form = (value: ProjectView) => renderToStaticMarkup(<DetailsForm project={value} name={value.name} notes={value.notes} onName={() => {}} onNotes={() => {}} onSave={() => {}} onAskDelete={() => {}} working={false} storage={{ photos: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 }, folder: null }} />);

test("details label name and notes, and offer deletion", () => {
  const html = form(project);
  expect(unlabelledInputs(html)).toEqual([]);
  expect(html).toContain('class="field text-area-field"><label for="project-notes"');
  expect(html).toContain("Delete project");
  expect(untranslatedText(html, [project.name, project.notes])).toEqual([]);
  const sample = form({ ...project, builtin: "sample", notes: "<flight>" });
  expect(sample).not.toContain('id="project-name"');
  expect(sample).toContain("cannot be renamed");
  expect(sample).not.toContain('id="project-notes"');
  expect(sample).not.toContain("Save project");
  expect(sample).toContain("Sample project");
  expect(sample).toContain("&lt;flight&gt;");
  expect(sample).not.toContain("<flight>");
  expect(sample).not.toContain("<form");
});

test("the Details section is titled Details and names its project", () => {
  const html = renderToStaticMarkup(<DetailsSection project={project} onChange={() => {}} onAuthRequired={() => {}} />);
  expect(html).toContain(">Details</h1>");
  expect(html).toContain("Field &lt;survey&gt;");
});

test("project confirmation names the project, removed items, sizes and preserved folder", () => {
  const html = renderToStaticMarkup(<DeleteConfirmation open busy={false} onCancel={() => {}} onConfirm={() => {}} target={{ kind: "project", project: { ...project, resultsBytes: 1024, resultArchives: [{ runId: 7, size: 1024 }] }, storage: { photos: { count: 2, bytes: 3072 }, other: { count: 0, bytes: 0 }, folder: { state: "ready", path: "/flight/photos" } } }} />);
  expect(html).toContain("Field &lt;survey&gt;");
  expect(html).toContain("Uploaded photos: 2 (3 KiB)");
  expect(html).toContain("Result archives: 1 (1 KiB)");
  expect(html).toContain("/flight/photos");
  expect(html).toContain("stays as it is");
  expect(html).toContain("Keep project");
  expect(html).toContain("Delete project and 4 KiB");
});

test("details show archive sizes for each run and their total", () => {
  const html = form({ ...project, resultsBytes: 3072, resultArchives: [{ runId: 7, size: 1024 }, { runId: 8, size: 2048 }] });
  expect(html).toContain("3 KiB");
  expect(html).toContain("1 KiB");
  expect(html).toContain("2 KiB");
  expect(html).toContain("#/runs/7");
  expect(html).toContain("#/runs/8");
});

test("Details separates its storage table and danger area from Save", () => {
  const html = form({ ...project, resultsBytes: 3072, resultArchives: [{ runId: 7, size: 1024 }, { runId: 8, size: 2048 }] });
  expect(html).toContain("<table");
  expect(html).toContain("Uploaded photos");
  expect(html).toContain("Total");
  expect(html).toContain('class="details-danger"');
  expect(html).not.toContain('class="danger"');
});
