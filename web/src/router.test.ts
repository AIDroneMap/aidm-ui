import { expect, test } from "bun:test";
import { changedOnlyFromHash, redirectFromHash, resultsHash, routeFromHash, ROUTE_MAP, SECTIONS, sectionHash, settingsHash, wizardHash, wizardStepFromHash, WIZARD_STEPS } from "./router.ts";

test("the route map lists every address of the proposal, each opening its own screen", () => {
  expect(ROUTE_MAP.map(({ hash }) => hash)).toEqual([
    "#/",
    "#/projects/7/photos",
    "#/projects/7/settings",
    "#/projects/7/review",
    "#/projects/7/runs",
    "#/runs/9",
    "#/projects/7/results",
    "#/projects/7/results/9",
    "#/projects/7/results/9/map",
    "#/projects/7/results/9/model",
    "#/projects/7/details",
    "#/engines",
    "#/preferences",
    "#/wizard",
    "#/wizard/check",
    "#/wizard/engine",
    "#/wizard/install",
    "#/wizard/sample",
  ]);
  for (const { hash, route } of ROUTE_MAP) {
    expect(routeFromHash(hash), hash).toEqual(route);
    expect(redirectFromHash(hash), hash).toBeNull();
  }
  // Every section of a project has an address in the map.
  for (const section of SECTIONS) expect(ROUTE_MAP.some(({ hash }) => hash === sectionHash(7, section))).toBe(true);
});

test("the address helpers build the addresses the router reads", () => {
  expect(sectionHash(3, "details")).toBe("#/projects/3/details");
  expect(routeFromHash(resultsHash(3, 4))).toEqual({ screen: "project", projectId: 3, section: "results", runId: 4 });
  expect(routeFromHash(resultsHash(3, 4, "model"))).toEqual({ screen: "project", projectId: 3, section: "results", runId: 4, viewer: "model" });
});

test("old addresses go to their new place", () => {
  expect(redirectFromHash("#/projects/42")).toBe("#/projects/42/photos");
  expect(redirectFromHash("#/settings")).toBe("#/preferences");
  expect(redirectFromHash("#/projects/new")).toBe("#/");
  for (const hash of ["#/", "#/projects/0", "#/projects/42/extra", "#/settings/extra", "#/sample"]) expect(redirectFromHash(hash), hash).toBeNull();
});

test("every wizard screen has its own address", () => {
  for (const step of WIZARD_STEPS) {
    expect(routeFromHash(wizardHash(step))).toEqual({ screen: "wizard", step });
    expect(wizardStepFromHash(wizardHash(step))).toBe(step);
  }
  expect(wizardStepFromHash("#/wizard")).toBe("welcome");
  expect(wizardStepFromHash("#/preferences")).toBeNull();
});

test("anything else is the Projects screen", () => {
  for (const hash of ["", "#", "#/", "#/home", "#/settings", "#/sample", "#/preferences/extra", "#/engines/extra", "#/wizard/extra", "#/wizard/", "#/unknown",
    "#/projects/0/photos", "#/projects/01/photos", "#/projects/7", "#/projects/7/other", "#/projects/7/photos/extra", "#/projects/7/results/0", "#/projects/7/results/9/other", "#/projects/7/review/9",
    "#/runs/0", "#/runs/new", "#/runs/42/extra", "#/runs/01"]) {
    expect(routeFromHash(hash), hash).toEqual({ screen: "projects" });
  }
});

test("Settings keeps Changed only in its address, and no other address takes the flag", () => {
  expect(settingsHash(7, true)).toBe("#/projects/7/settings?changed");
  expect(settingsHash(7, false)).toBe(sectionHash(7, "settings"));
  expect(routeFromHash("#/projects/7/settings?changed")).toEqual({ screen: "project", projectId: 7, section: "settings" });
  expect(changedOnlyFromHash("#/projects/7/settings?changed")).toBe(true);
  expect(changedOnlyFromHash("#/projects/7/settings")).toBe(false);
  expect(routeFromHash("#/projects/7/photos?changed")).toEqual({ screen: "projects" });
  expect(changedOnlyFromHash("#/projects/7/photos?changed")).toBe(false);
  expect(redirectFromHash("#/projects/7/settings?changed")).toBeNull();
});
