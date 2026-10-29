import { expect, test } from "bun:test";
import { browserCheck } from "./browser-check.tsx";

test("controls support keyboard use and visible focus in a browser", async () => {
  expect(await browserCheck()).toEqual([]);
}, 45000);
