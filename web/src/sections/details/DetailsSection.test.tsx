import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectView } from "../../../../shared/api-types.ts";
import { DeleteConfirmation, DetailsForm, DetailsSection } from "./DetailsSection.tsx";
import { untranslatedText, unlabelledInputs } from "../../test-helpers.ts";

const project: ProjectView = { id: 4, name: "Field <survey>", notes: "notes", builtin: null, photoCount: 2, runCount: 1, latestState: "completed", lastChange: "2024-02-01T00:00:00.000Z" };
const form = (value: ProjectView) => renderToStaticMarkup(<DetailsForm project={value} name={value.name} notes={value.notes} onName={() => {}} onNotes={() => {}} onSave={() => {}} onAskDelete={() => {}} working={false} />);

test("details label name and notes, and offer deletion", () => {
  const html = form(project);
  expect(unlabelledInputs(html)).toEqual([]);
  expect(html).toContain('for="project-notes"');
  expect(html).toContain("Delete project");
  expect(untranslatedText(html, [project.name, project.notes])).toEqual([]);
  const sample = form({ ...project, builtin: "sample" });
  expect(sample).not.toContain('id="project-name"');
  expect(sample).toContain("cannot be renamed");
});

test("the Details section is titled Details and names its project", () => {
  const html = renderToStaticMarkup(<DetailsSection project={project} onChange={() => {}} onAuthRequired={() => {}} />);
  expect(html).toContain(">Details</h1>");
  expect(html).toContain("Field &lt;survey&gt;");
});

test("delete confirmation names what is removed and what stays", () => {
  const html = renderToStaticMarkup(<DeleteConfirmation working={false} onKeep={() => {}} onDelete={() => {}} />);
  expect(html).toContain("uploaded photos, archives and runs on every engine");
  expect(html).toContain("Imported folders stay where they are");
  expect(html).toContain("Keep project");
  expect(html).toContain("Delete project");
});

test("details show archive sizes for each run and their total", () => {
  const html = form({ ...project, resultsBytes: 3072, resultArchives: [{ runId: 7, size: 1024 }, { runId: 8, size: 2048 }] });
  expect(html).toContain("3 KiB");
  expect(html).toContain("1 KiB");
  expect(html).toContain("2 KiB");
  expect(html).toContain("#/runs/7");
  expect(html).toContain("#/runs/8");
});
