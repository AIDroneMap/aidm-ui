import { expect, test } from "bun:test";
import { routeFromHash, wizardHash, wizardStepFromHash, WIZARD_STEPS } from "./router.ts";

test("#/settings is the settings page", () => {
  expect(routeFromHash("#/settings")).toBe("settings");
});

test("#/engines is the engines page", () => {
  expect(routeFromHash("#/engines")).toBe("engines");
});

test("#/sample is the sample job page", () => {
  expect(routeFromHash("#/sample")).toBe("sample");
});

test("every wizard screen has its own address and is the wizard route", () => {
  for (const step of WIZARD_STEPS) {
    expect(routeFromHash(wizardHash(step))).toBe("wizard");
    expect(wizardStepFromHash(wizardHash(step))).toBe(step);
  }
  expect(wizardStepFromHash("#/wizard")).toBe("welcome");
  expect(wizardStepFromHash("#/wizard/check")).toBe("check");
  expect(wizardStepFromHash("#/settings")).toBeNull();
});

test("anything else is home", () => {
  for (const hash of ["", "#", "#/", "#/home", "#/settings/extra", "#/engines/extra", "#/sample/extra", "#/wizard/extra", "#/wizard/", "#/unknown"]) {
    expect(routeFromHash(hash)).toBe("home");
  }
});
