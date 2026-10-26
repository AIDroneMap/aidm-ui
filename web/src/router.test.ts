import { expect, test } from "bun:test";
import { routeFromHash } from "./router.ts";

test("#/settings is the settings page", () => {
  expect(routeFromHash("#/settings")).toBe("settings");
});

test("anything else is home", () => {
  for (const hash of ["", "#", "#/", "#/home", "#/settings/extra", "#/unknown"]) {
    expect(routeFromHash(hash)).toBe("home");
  }
});
