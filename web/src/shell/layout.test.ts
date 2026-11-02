import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { SECTIONS } from "../router.ts";

test("each section of a project has a folder of its own", () => {
  for (const section of SECTIONS) expect(existsSync(new URL(`../sections/${section}/`, import.meta.url)), section).toBe(true);
});
