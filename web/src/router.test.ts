import { expect, test } from "bun:test";
import { routeFromHash } from "./router.ts";

test("#/settings is the settings page", () => {
  expect(routeFromHash("#/settings")).toBe("settings");
});

test("#/engines is the engines page", () => {
  expect(routeFromHash("#/engines")).toBe("engines");
});

test("#/sample is the sample job page", () => {
  expect(routeFromHash("#/sample")).toBe("sample");
});

test("anything else is home", () => {
  for (const hash of ["", "#", "#/", "#/home", "#/settings/extra", "#/engines/extra", "#/sample/extra", "#/unknown"]) {
    expect(routeFromHash(hash)).toBe("home");
  }
});
