import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectView } from "../../../shared/api-types.ts";
import { NewProjectDialog, ProjectList } from "./ProjectsPage.tsx";
import { untranslatedText, unlabelledInputs } from "../test-helpers.ts";

const project: ProjectView = { id: 4, name: "Field <survey>", notes: "notes", builtin: null, photoCount: 2, runCount: 1, latestState: "completed", lastChange: "2024-02-01T00:00:00.000Z" };
test("project list presents the new action first and all five facts as data", () => {
  const html = renderToStaticMarkup(<ProjectList projects={[project, { ...project, id: 5, name: "untranslated", builtin: "sample" }]} onNew={() => {}} />);
  expect(html.indexOf("New project")).toBeLessThan(html.indexOf("Field &lt;survey&gt;"));
  expect(html).toContain('#/projects/4/photos');
  expect(html).toContain("Finished");
  expect(html).toContain("Sample project");
  expect(html).not.toContain("untranslated");
  expect(html).toContain('dateTime="2024-02-01T00:00:00.000Z"');
});

test("with no project the screen says what to do first and offers New project once", () => {
  const html = renderToStaticMarkup(<ProjectList projects={[]} onNew={() => {}} />);
  expect(html).toContain("No projects yet");
  expect(html).toContain("Create a project, then add the photos of a flight.");
  expect(html.match(/New project/g)).toHaveLength(1);
  expect(html).not.toContain("<table");
  expect(untranslatedText(html)).toEqual([]);
});

test("the new-project dialog asks only for a labelled name", () => {
  const html = renderToStaticMarkup(<NewProjectDialog onClose={() => {}} onAuthRequired={() => {}} />);
  expect(unlabelledInputs(html)).toEqual([]);
  expect(html).toContain('id="new-project-name"');
  expect(html).toContain("required");
  expect(html).toContain("Create project");
  expect(html).toContain("Cancel");
  expect(untranslatedText(html)).toEqual([]);
});
