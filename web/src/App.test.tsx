import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectView } from "../../shared/api-types.ts";
import en from "./i18n/en.json";
import { App } from "./App.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";
import { routeFromHash } from "./router.ts";
import { Shell } from "./shell/Shell.tsx";
import { textNodes, untranslatedText } from "./test-helpers.ts";

const project: ProjectView = { id: 7, name: "Vineyard north", notes: "", builtin: null, photoCount: 312, runCount: 2, latestState: "processing", lastChange: "2026-11-01T00:00:00.000Z", resultsBytes: 3, resultArchives: [{ runId: 1, size: 1 }, { runId: 2, size: 2 }] };

test("the Projects screen shows only text from the translation file", () => {
  const html = renderToStaticMarkup(<Shell route={{ screen: "projects" }} project={null}><ProjectsPage onAuthRequired={() => {}} /></Shell>);
  expect(untranslatedText(html)).toEqual([]);
  expect(textNodes(html)).toContain(en["projects.loading"]);
});

test("the sidebar lists Projects, Engines and Preferences, and marks the current one", () => {
  const html = renderToStaticMarkup(<Shell route={routeFromHash("#/preferences")} project={null}><p /></Shell>);
  expect(html).toMatch(/<a class="nav-item" href="#\/preferences" aria-current="page">.*Preferences/);
  expect(html).toContain('href="#/"');
  expect(html).toContain('href="#/engines"');
  expect(html).not.toContain('href="#/settings"');
  expect(html).not.toContain(">Settings<");
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
});

test("inside a project the sidebar names it, lists its six sections and their badges", () => {
  const html = renderToStaticMarkup(<Shell route={routeFromHash("#/projects/7/results/2/map")} project={project}><p /></Shell>);
  expect(html).toContain("Vineyard north");
  for (const section of ["photos", "settings", "review", "runs", "results", "details"]) expect(html).toContain(`href="#/projects/7/${section}"`);
  expect(html).toMatch(/href="#\/projects\/7\/results" aria-current="page"/);
  expect(html).toContain("Photos: 312");
  expect(html).toContain("A run is in progress");
  expect(html).toContain("Runs with results: 2");
  expect(untranslatedText(html, ["Vineyard north", "312", "2"])).toEqual([]);
});

test("a finished project has no run badge, and a run marks its project's Runs section", () => {
  const html = renderToStaticMarkup(<Shell route={routeFromHash("#/runs/2")} project={{ ...project, latestState: "completed", photoCount: 0, resultArchives: [] }}><p /></Shell>);
  expect(html).not.toContain("A run is in progress");
  expect(html).not.toContain("Photos: ");
  expect(html).toMatch(/href="#\/projects\/7\/runs" aria-current="page"/);
});

test("the menu button names what it does and the navigation it opens", () => {
  const html = renderToStaticMarkup(<Shell route={{ screen: "projects" }} project={null}><p /></Shell>);
  expect(html).toContain('aria-label="Show the menu"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-controls="shell-nav"');
});

test("before the session answer, the app only says it is loading", () => {
  const html = renderToStaticMarkup(<App />);
  expect(textNodes(html)).toEqual([en["app.loading"]]);
});
