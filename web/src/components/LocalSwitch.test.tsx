import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../api.ts";
import type { LocalEngineView } from "../../../shared/api-types.ts";
import { fresh } from "../localEngine.fixtures.ts";
import { unlabelledInputs, untranslatedText } from "../test-helpers.ts";
import { SwitchView, type SwitchProps } from "./LocalSwitch.tsx";

const running: LocalEngineView = {
  ...fresh,
  installed: { packageVersion: "2.5.0", variant: "linux-amd64-cpu", kind: "container", runtime: "podman" },
  engineId: 1,
  state: "ready",
};

function render(view: LocalEngineView = running, overrides: Partial<SwitchProps> = {}): string {
  return renderToStaticMarkup(
    <SwitchView view={view} busy={false} failure={null} onToggle={() => {}} onStartAgain={() => {}} {...overrides} />,
  );
}

test("the switch is a labelled control that is on while the engine is on", () => {
  const html = render();
  expect(html).toContain('role="switch"');
  expect(html).toContain('<label for="local-enabled">Run the engine on this computer</label>');
  expect(html).toMatch(/<input[^>]*id="local-enabled"[^>]*checked=""/);
  expect(html).toContain('aria-describedby="local-enabled-hint"');
  expect(html).toContain("When this is off, the engine stays stopped, also after AIDM UI starts again.");
  expect(unlabelledInputs(html)).toEqual([]);
  expect(untranslatedText(html)).toEqual([]);
});

test("the switch is off when the engine is switched off", () => {
  const html = render({ ...running, enabled: false, state: "stopped" });
  expect(html).not.toMatch(/<input[^>]*checked=""/);
});

test("a busy switch says so to assistive technology and stays in the tab order", () => {
  const html = render(running, { busy: true });
  expect(html).toContain('aria-disabled="true"');
  expect(html).not.toMatch(/<input[^>]*\sdisabled/);
});

test("the tries to bring the engine back are counted in words, in a status region", () => {
  const html = render({ ...running, state: "unreachable", restarts: { attempts: 2, max: 5, nextAt: "2026-10-26T10:00:04.000Z" } });
  expect(html).toContain('<div role="status"><p>Restarting the engine: try 2 of 5</p></div>');
  expect(untranslatedText(html)).toEqual([]);
  expect(render()).not.toContain("Restarting the engine");
});

test("after the manager gave up the engine can be started again with a button", () => {
  const gaveUp: LocalEngineView = {
    ...running,
    state: "failed",
    problem: { code: "local.restart_gave_up", data: { attempts: 5 } },
  };
  const html = render(gaveUp);
  expect(html).toContain(">Start the engine again</button>");
  expect(render()).not.toContain("Start the engine again");
  expect(render(gaveUp, { busy: true })).toContain("Starting the engine...");
  expect(render(gaveUp, { busy: true })).toContain('aria-disabled="true"');
});

test("a refusal of the switch is shown as an alert", () => {
  const html = render(running, { failure: new ApiFailure(409, "install.already_running") });
  expect(html).toContain('role="alert"');
  expect(html).toContain("The engine is already being installed.");
});
