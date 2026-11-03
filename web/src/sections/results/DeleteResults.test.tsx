import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunView } from "../../../../shared/api-types.ts";
import { DeleteResults } from "./DeleteResults.tsx";

const run: RunView = {
  id: 7, projectId: 3, name: "North block", preset: null, wayIn: null, sample: false, engineId: 1, engineName: "Field engine", engineLocal: false,
  state: "completed", step: null, download: null, upload: null, progress: null, engineMessage: null, problem: null, restarted: false, restartedAtLine: null,
  resultsAvailable: true, results: { state: "ready", archiveSize: 250 * 1024 ** 2, outputs: [] }, createdAt: "2026-11-02T10:00:00Z",
};

test("the results of a run are deleted through the shared deletion dialog, which names the run, the archive and its size", () => {
  const html = renderToStaticMarkup(<DeleteResults run={run} onDeleted={() => {}} />);
  expect(html).toContain('<section class="results-danger"');
  expect(html).toContain(">Delete the results of this run</button>");
  expect(html).toContain('<dialog class="confirm-dialog confirm-danger"');
  expect(html).toContain("Delete the results of &quot;North block&quot;?");
  expect(html).toContain("Local result archive: 250 MiB");
  expect(html).toContain(">Delete results and 250 MiB</button>");
  expect(html).toContain(">Keep results</button>");
});
