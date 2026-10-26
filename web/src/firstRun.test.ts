import { expect, test } from "bun:test";
import { firstRunRedirect } from "./firstRun.ts";

test("a first-run operator on the home page is sent to the wizard once, when the answer arrives", () => {
  const redirect = firstRunRedirect();
  expect(redirect("home", null)).toBe(false);
  expect(redirect("home", false)).toBe(true);
});

test("later visits to the home page are not sent back", () => {
  const redirect = firstRunRedirect();
  expect(redirect("home", false)).toBe(true);
  expect(redirect("wizard", false)).toBe(false);
  expect(redirect("home", false)).toBe(false);
  expect(redirect("home", false)).toBe(false);
});

test("a page that opens somewhere else is never redirected later", () => {
  const redirect = firstRunRedirect();
  expect(redirect("engines", false)).toBe(false);
  expect(redirect("home", false)).toBe(false);
});

test("an operator who has finished the wizard is not redirected", () => {
  const redirect = firstRunRedirect();
  expect(redirect("home", true)).toBe(false);
  expect(redirect("home", false)).toBe(false);
});
