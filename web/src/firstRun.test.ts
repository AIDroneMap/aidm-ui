import { expect, test } from "bun:test";
import { firstRunRedirect } from "./firstRun.ts";

test("a first-run operator on the Projects screen is sent to the wizard once, when the answer arrives", () => {
  const redirect = firstRunRedirect();
  expect(redirect("projects", null)).toBe(false);
  expect(redirect("projects", false)).toBe(true);
});

test("later visits to the Projects screen are not sent back", () => {
  const redirect = firstRunRedirect();
  expect(redirect("projects", false)).toBe(true);
  expect(redirect("wizard", false)).toBe(false);
  expect(redirect("projects", false)).toBe(false);
  expect(redirect("projects", false)).toBe(false);
});

test("a page that opens somewhere else is never redirected later", () => {
  const redirect = firstRunRedirect();
  expect(redirect("engines", false)).toBe(false);
  expect(redirect("projects", false)).toBe(false);
});

test("an operator who has finished the wizard is not redirected", () => {
  const redirect = firstRunRedirect();
  expect(redirect("projects", true)).toBe(false);
  expect(redirect("projects", false)).toBe(false);
});
