import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunActions } from "./RunActions.tsx";
import { RunRows } from "./RunHistory.tsx";
import type { RunView } from "../../../shared/api-types.ts";

const run = { id: 12, projectId: 1, name: "Field <north>", engineId: 3, engineName: "Engine A", engineLocal: false, preset: "quick-map", presetName: "Vineyard", state: "failed", step: null, sample: false, createdAt: "2026-10-31T12:00:00.000Z" } as RunView;
test("failed runs offer retry, changed settings and explicit deletion", () => {
  const html = renderToStaticMarkup(<RunActions run={run} onAuthRequired={() => {}} onAgain={() => {}} />);
  expect(html).toContain("Retry");
  expect(html).toContain("Run again with other settings");
  expect(html).toContain("Delete run");
  const active = renderToStaticMarkup(<RunActions run={{ ...run, state: "processing" }} onAuthRequired={() => {}} onAgain={() => {}} />);
  expect(active).not.toContain("Run again"); expect(active).not.toContain(">Retry<");
});
test("run rows expose name, engine, saved preset, state and date without raw markup", () => {
  const html = renderToStaticMarkup(<RunRows runs={[run]} />);
  for (const value of ["Field &lt;north&gt;", "Engine A", "Vineyard", "Failed", "#/runs/12", "2026-10-31T12:00:00.000Z"]) expect(html).toContain(value);
});

test("sample and unnamed historical runs keep readable link names", () => {
  const html = renderToStaticMarkup(<RunRows runs={[{ ...run, sample: true, name: "run.sample_name" }, { ...run, id: 13, name: "" }]} />);
  expect(html).not.toContain("run.sample_name");
  expect(html).toContain("Run 13");
});
