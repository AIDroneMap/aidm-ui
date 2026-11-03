import { expect, test } from "bun:test";
import type { EngineOption } from "../../shared/engine-options.ts";
import { assertEditorRows } from "../../test-support/catalogue-drift.ts";
import recorded from "../../test-support/fixtures/task-api-2.7.0-options.json";
import { reconcileOptions } from "./reconcile.ts";

const released = () => structuredClone(recorded) as EngineOption[];

test("the recorded 2.7.0 list gives one explained row per option, each matching the catalogue", () => {
  const rows = reconcileOptions(released());
  expect(rows).toHaveLength(80);
  expect(() => assertEditorRows(released(), rows, "2.7.0")).not.toThrow();
  expect(rows.filter((row) => row.changes.length).map((row) => row.name)).toEqual([]);
});

test("the count check fails on a row that is unexplained, missing or extra", () => {
  const added = [...released(), { name: "brand-new-option", type: "bool", value: "false", domain: "", help: "New help" } satisfies EngineOption];
  expect(() => assertEditorRows(added, reconcileOptions(added), "2.7.0")).toThrow('"unexplained":["brand-new-option"]');

  // A name the catalogue keeps as not offered never becomes a row, so a task API that starts offering it fails here.
  const offered = [...released(), { name: "gcp", type: "string", value: "", domain: "path", help: "Ground control" } satisfies EngineOption];
  expect(() => assertEditorRows(offered, reconcileOptions(offered), "2.7.0")).toThrow('"dropped":["gcp"]');

  const rows = reconcileOptions(released());
  expect(() => assertEditorRows(released(), rows.slice(1), "2.7.0")).toThrow(`"dropped":["${rows[0]!.name}"]`);
  expect(() => assertEditorRows(released().filter((option) => option.name !== rows[0]!.name), rows, "2.7.0")).toThrow(`"extra":["${rows[0]!.name}"]`);
  expect(() => assertEditorRows(released(), [...rows, rows[0]!], "2.7.0")).toThrow("81 rows for 80 options");
});

test("a process count the engine took from its machine is not a change from the catalogue", () => {
  const options = released().map((option) => option.name === "max-concurrency" ? { ...option, value: "32" } : option);
  const row = reconcileOptions(options).find((option) => option.name === "max-concurrency");
  expect(row).toMatchObject({ defaultValue: 32, changes: [], group: "performance-and-limits" });
  const tiles = reconcileOptions(released().map((option) => option.name === "tiles" ? { ...option, value: "true" } : option)).find((option) => option.name === "tiles");
  expect(tiles?.changes).toEqual(["defaultValue"]);
});

test("every row keeps the engine's help, so the settings row can quote the engine's own words", () => {
  const rows = reconcileOptions(released());
  for (const option of released()) expect(rows.find((row) => row.name === option.name)?.help, option.name).toBe(option.help);
});
