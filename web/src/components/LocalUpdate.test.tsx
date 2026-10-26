import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../api.ts";
import type { LocalEngineView } from "../../../shared/api-types.ts";
import en from "../i18n/en.json";
import { caps, fresh } from "../localEngine.fixtures.ts";
import { unlabelledInputs, untranslatedText } from "../test-helpers.ts";
import { LocalAdvanced } from "./LocalAdvanced.tsx";
import { UpdateView, type UpdateViewProps } from "./LocalUpdate.tsx";

const installed: LocalEngineView = {
  ...fresh,
  installed: { packageVersion: "2.5.0", variant: "linux-amd64-cpu", kind: "container", runtime: "podman" },
  engineId: 1,
  state: "ready",
  caps,
};

const withUpdate: LocalEngineView = {
  ...installed,
  update: { available: { packageVersion: "2.6.0", size: 682_533_845 }, previous: null, blockedBy: null, applying: null },
};

function render(view: LocalEngineView, overrides: Partial<UpdateViewProps> = {}): string {
  return renderToStaticMarkup(
    <UpdateView view={view} requesting={false} failure={null} onUpdate={() => {}} onRollback={() => {}} {...overrides} />,
  );
}

test("an update on offer shows its version and size and an Update button that is ready", () => {
  const html = render(withUpdate);
  expect(html).toContain("Engine update: 2.6.0 (651 MiB)");
  expect(html).toContain(">Update</button>");
  expect(html).not.toContain("aria-disabled");
  expect(html).not.toContain("Go back");
  expect(untranslatedText(html)).toEqual([]);
  expect(unlabelledInputs(html)).toEqual([]);
});

test("with nothing on offer, no previous version and no problem, the block is not shown", () => {
  expect(render(installed)).toBe("");
  expect(render(fresh)).toBe("");
});

test("with a run in progress the button is aria-disabled and the reason is its description", () => {
  const html = render({
    ...withUpdate,
    update: { ...withUpdate.update, blockedBy: { code: "update.run_in_progress", data: {} } },
  });
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-describedby="local-update-blocked"/);
  expect(html).not.toMatch(/(?<!aria-)disabled=/);
  expect(html).toContain(`<p id="local-update-blocked" class="hint">${en["update.run_in_progress"]}</p>`);
  expect(untranslatedText(html)).toEqual([]);
});

test("while an update downloads, the progress shows like an install and the button is busy", () => {
  const html = render({
    ...withUpdate,
    update: {
      ...withUpdate.update,
      applying: { phase: "pulling", size: 682_533_845, layersDone: 2, layersTotal: 5, attempt: 2, maxAttempts: 5 },
    },
  });
  expect(html).toContain("Downloading the engine:");
  expect(html).toContain('<progress id="update-progress" max="5" value="2">');
  expect(html).toContain("2 of 5 parts");
  expect(html).toContain("Try 2 of 5");
  expect(html).toMatch(/aria-disabled="true"[^>]*>Working\.\.\.<\/button>/);
  expect(untranslatedText(html)).toEqual([]);
});

test("while the new version starts, the status says so", () => {
  const html = render({
    ...withUpdate,
    update: { ...withUpdate.update, applying: { phase: "starting", size: 1, layersDone: null, layersTotal: null, attempt: 1, maxAttempts: 5 } },
  });
  expect(html).toContain('<div role="status"><p>Starting the engine</p></div>');
  expect(html).not.toContain("<progress");
});

test("a previous version offers the way back with its version in the button", () => {
  const html = render({
    ...installed,
    update: { available: null, previous: { packageVersion: "2.4.0" }, blockedBy: null, applying: null },
  });
  expect(html).toContain(">Go back to 2.4.0</button>");
  expect(html).not.toContain(">Update</button>");
  expect(html).not.toContain("aria-disabled");
});

test("the way back is refused for the same reason as the update", () => {
  const html = render({
    ...installed,
    update: { available: null, previous: { packageVersion: "2.4.0" }, blockedBy: { code: "update.run_in_progress", data: {} }, applying: null },
  });
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Go back to 2\.4\.0<\/button>/);
  expect(html).toContain(en["update.run_in_progress"]);
});

test("an update that was undone is reported with the version that failed", () => {
  const html = render({
    ...withUpdate,
    problem: { code: "update.failed_rolled_back", data: { version: "2.6.0" } },
  });
  expect(html).toContain('role="alert"');
  expect(html).toContain("The new engine version 2.6.0 did not get ready, so AIDM UI started the earlier version again.");
  expect(untranslatedText(html)).toEqual([]);
});

test("a failed rollback and an update that could not download are reported too", () => {
  const rollback = render({
    ...installed,
    problem: { code: "update.rollback_failed", data: { version: "2.4.0" } },
    update: { available: null, previous: { packageVersion: "2.4.0" }, blockedBy: null, applying: null },
  });
  expect(rollback).toContain("The version 2.4.0 did not get ready");
  const download = render({ ...withUpdate, problem: { code: "install.pull_failed", data: { attempts: 5 } } });
  expect(download).toContain(en["install.pull_failed"]);
});

test("a problem of the engine failing to start is left to the engines list, where it already shows", () => {
  const html = render({
    ...withUpdate,
    state: "failed",
    problem: { code: "install.start_failed", data: { cause: { code: "runtime.start_failed", data: {} } } },
  });
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain(en["install.start_failed"]);
});

test("an engine that has just changed version is announced in the status region", () => {
  const html = render(withUpdate, { announcement: "2.6.0" });
  expect(html).toContain('<div role="status"><p>The engine is now version 2.6.0.</p></div>');
  expect(untranslatedText(html)).toEqual([]);
  expect(render(withUpdate)).toContain('<div role="status"></div>');
});

test("a problem of the engine itself is not repeated in the update block", () => {
  const html = render({ ...withUpdate, problem: { code: "engine.unreachable", data: {} } });
  expect(html).not.toContain('role="alert"');
});

test("the refusal to a click is shown in words", () => {
  const html = render(withUpdate, { failure: new ApiFailure(409, "update.run_in_progress", {}) });
  expect(html).toContain('role="alert"');
  expect(html).toContain(en["update.run_in_progress"]);
});

test("a click while the request is on its way leaves the button busy", () => {
  expect(render(withUpdate, { requesting: true })).toMatch(/aria-disabled="true"[^>]*>Working\.\.\.<\/button>/);
});

test("the update block sits in the Advanced section of the local engine", () => {
  const html = renderToStaticMarkup(<LocalAdvanced view={withUpdate} onView={() => {}} onAuthRequired={() => {}} />);
  const section = html.slice(html.indexOf('id="local-advanced"'));
  expect(section.indexOf('id="local-update"')).toBeGreaterThan(0);
  expect(section).toContain("Engine update: 2.6.0");
  expect(untranslatedText(html)).toEqual([]);
});
