import { expect, test } from "bun:test";
import type { ProjectView } from "../../../shared/api-types.ts";
import { runActive } from "./useWorkspaceProject.ts";

const project = (latestState: ProjectView["latestState"], activeRunCount: number) => ({ latestState, activeRunCount });

test("a project is busy while any of its runs is unfinished, whatever its latest run did", () => {
  expect(runActive(project("failed", 1))).toBe(true);
  expect(runActive(project("processing", 1))).toBe(true);
  expect(runActive(project("completed", 0))).toBe(false);
  expect(runActive(project(null, 0))).toBe(false);
});
