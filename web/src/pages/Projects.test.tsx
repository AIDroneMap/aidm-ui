import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectView } from "../../../shared/api-types.ts";
import { ProjectList } from "./HomePage.tsx";
import { DeleteConfirmation, ProjectForm } from "./ProjectPage.tsx";
import { untranslatedText, unlabelledInputs } from "../test-helpers.ts";

const project: ProjectView = { id: 4, name: "Field <survey>", notes: "notes", builtin: null, photoCount: 2, runCount: 1, latestState: "completed", lastChange: "2024-02-01T00:00:00.000Z" };
test("project list presents the new action first and all five facts as data", () => {
  const html = renderToStaticMarkup(<ProjectList projects={[project, { ...project, id: 5, name: "untranslated", builtin: "sample" }]} />);
  expect(html.indexOf("New project")).toBeLessThan(html.indexOf("Field &lt;survey&gt;"));
  expect(html).toContain('#/projects/4');
  expect(html).toContain("Finished");
  expect(html).toContain("Sample project");
  expect(html).not.toContain("untranslated");
  expect(html).toContain('dateTime="2024-02-01T00:00:00.000Z"');
});

test("project forms label name and notes, and explain deletion", () => {
  const html = renderToStaticMarkup(<ProjectForm project={project} name={project.name} notes={project.notes} onName={() => {}} onNotes={() => {}} onSave={() => {}} onAskDelete={() => {}} working={false} />);
  expect(unlabelledInputs(html)).toEqual([]);
  expect(html).toContain('for="project-notes"');
  expect(html).toContain("Delete project");
  expect(untranslatedText(html, [project.name, project.notes])).toEqual([]);
  const sample = renderToStaticMarkup(<ProjectForm project={{ ...project, builtin: "sample" }} name={project.name} notes="" onName={() => {}} onNotes={() => {}} onSave={() => {}} onAskDelete={() => {}} working={false} />);
  expect(sample).not.toContain('id="project-name"');
  expect(sample).toContain("Sample project");
});

test("delete confirmation names what is removed and what stays", () => {
  const html = renderToStaticMarkup(<DeleteConfirmation working={false} onKeep={() => {}} onDelete={() => {}} />);
  expect(html).toContain("uploaded photos, archives and runs on every engine");
  expect(html).toContain("Imported folders stay where they are");
  expect(html).toContain("Keep project");
  expect(html).toContain("Delete project");
});

test("project shows archive sizes for each run and their total", () => {
  const html = renderToStaticMarkup(<ProjectForm project={{ ...project, resultsBytes: 3072, resultArchives: [{ runId: 7, size: 1024 }, { runId: 8, size: 2048 }] }} name={project.name} notes={project.notes} onName={() => {}} onNotes={() => {}} onSave={() => {}} onAskDelete={() => {}} working={false} />);
  expect(html).toContain("3 KiB");
  expect(html).toContain("1 KiB");
  expect(html).toContain("2 KiB");
  expect(html).toContain("#/runs/7");
  expect(html).toContain("#/runs/8");
});
