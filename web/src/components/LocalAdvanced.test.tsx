import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../api.ts";
import type { LocalEngineView } from "../../../shared/api-types.ts";
import en from "../i18n/en.json";
import { caps, fresh } from "../localEngine.fixtures.ts";
import { unlabelledInputs, untranslatedText } from "../test-helpers.ts";
import { AdvancedForm, type AdvancedFormProps } from "./LocalAdvanced.tsx";

const GIB = 1024 ** 3;

const running: LocalEngineView = {
  ...fresh,
  installed: { packageVersion: "2.5.0", variant: "linux-amd64-cpu", kind: "container", runtime: "podman" },
  engineId: 1,
  state: "ready",
  caps: { ...caps, memoryBytes: 16 * GIB, cpus: 4, applied: { memoryBytes: 20 * GIB, cpus: 8 } },
};

function render(overrides: Partial<AdvancedFormProps> = {}, view: LocalEngineView = running): string {
  return renderToStaticMarkup(
    <AdvancedForm
      view={view}
      memoryDraft="16"
      cpusDraft="4"
      onMemoryDraftChange={() => {}}
      onCpusDraftChange={() => {}}
      saving={false}
      saved={false}
      failure={null}
      onSave={() => {}}
      runtimeSaving={false}
      runtimeSaved={false}
      runtimeFailure={null}
      onRuntimeChange={() => {}}
      forceCpuSaving={false}
      forceCpuSaved={false}
      forceCpuFailure={null}
      onForceCpuChange={() => {}}
      {...overrides}
    />,
  );
}

test("the limits are labelled inputs with the limits from the server", () => {
  const html = render();
  expect(html).toContain('<label for="local-memory">Memory for the engine (GiB)</label>');
  expect(html).toContain('<label for="local-cpus">CPU cores for the engine</label>');
  expect(html).toMatch(/id="local-memory"[^>]*type="number"/);
  expect(html).toContain('step="0.5"');
  expect(html).toContain('min="1"');
  expect(html).toContain('max="29.7"');
  expect(html).toContain('value="16"');
  expect(html).toContain('max="8"');
  expect(html).toContain('value="4"');
  expect(html).toContain("The most you can give it is 29.8 GiB.");
  expect(html).toContain("The most you can give it is 8.");
  expect(unlabelledInputs(html)).toEqual([]);
  expect(untranslatedText(html)).toEqual([]);
});

test("it says what the running engine got and that changes wait for the next start", () => {
  const html = render();
  expect(html).toContain("Running now: memory 20.0 GiB, CPU cores 8.");
  expect(html).toContain(en["local.advanced.next_start"]);
  expect(html).toContain(">Save the limits</button>");
});

test("a running engine without a memory cap says no limit, a stopped one says it is not running", () => {
  const uncapped = render({}, { ...running, caps: { ...running.caps, applied: { memoryBytes: null, cpus: 8 } } });
  expect(uncapped).toContain("Running now: memory no limit, CPU cores 8.");
  const stopped = render({}, { ...running, state: "stopped", caps: { ...running.caps, applied: null } });
  expect(stopped).toContain(en["local.advanced.not_running"]);
  expect(stopped).not.toContain("Running now");
});

test("a refused memory limit shows both limits in GiB and marks the field", () => {
  const html = render({
    memoryDraft: "99",
    failure: new ApiFailure(422, "caps.memory_invalid", { min: GIB, max: 29.77 * GIB }),
  });
  expect(html).toContain("Memory must be between 1.0 GiB and 29.8 GiB.");
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('aria-describedby="local-memory-hint local-caps-error"');
  expect(html).toContain('id="local-caps-error"');
  expect(untranslatedText(html)).toEqual([]);
});

test("a refused core count shows its limits and marks the field", () => {
  const html = render({
    cpusDraft: "99",
    failure: new ApiFailure(422, "caps.cpus_invalid", { min: 1, max: 8 }),
  });
  expect(html).toContain("CPU cores must be a whole number between 1 and 8.");
  expect(html).toMatch(/id="local-cpus"[^>]*aria-invalid="true"/);
});

test("a busy save keeps the button focusable and says so", () => {
  const html = render({ saving: true });
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain(">Saving...</button>");
  expect(render({ saved: true })).toContain(en["local.advanced.saved"]);
});

test("with two tools to choose from, the choice is three labelled radios and the current one is checked", () => {
  const html = render();
  expect(html).toContain("<legend>Tool that runs the engine</legend>");
  expect(html).toContain(">Automatic (Podman first)</label>");
  expect(html).toContain(">Podman</label>");
  expect(html).toContain(">Docker</label>");
  expect(html.match(/type="radio"/g)).toHaveLength(3);
  expect(html).toMatch(/id="local-runtime-auto"[^>]*checked=""/);
  const docker = render({}, { ...running, runtime: { ...running.runtime, preferred: "docker" } });
  expect(docker).toMatch(/id="local-runtime-docker"[^>]*checked=""/);
  expect(docker).not.toMatch(/id="local-runtime-auto"[^>]*checked=""/);
  expect(unlabelledInputs(html)).toEqual([]);
});

test("with one tool there is nothing to choose", () => {
  const html = render({}, { ...running, runtime: { chosen: "podman", available: ["podman"], preferred: null } });
  expect(html).not.toContain('type="radio"');
  expect(html).not.toContain("<fieldset");
});

test("a refused tool choice says so", () => {
  const html = render({ runtimeFailure: new ApiFailure(409, "runtime.not_available", {}) });
  expect(html).toContain(en["runtime.not_available"]);
});

test("Use the processor only is a labelled checkbox that follows the server, with its hint", () => {
  const off = render();
  expect(off).toContain('<label for="local-force-cpu">Use the processor only</label>');
  expect(off).toMatch(/<input id="local-force-cpu" type="checkbox"(?![^>]*checked)[^>]*>/);
  expect(off).toContain('aria-describedby="local-force-cpu-hint"');
  expect(off).toContain(en["local.advanced.force_cpu_hint"]);
  expect(unlabelledInputs(off)).toEqual([]);
  expect(untranslatedText(off)).toEqual([]);

  const on = render({}, { ...running, forceCpu: true });
  expect(on).toMatch(/<input id="local-force-cpu" type="checkbox"[^>]*checked=""/);
});

test("saving the processor choice says so in the status area, and a refusal is shown as an alert", () => {
  expect(render({ forceCpuSaved: true })).toContain(`<p role="status">${en["local.advanced.force_cpu_saved"]}</p>`);
  const refused = render({ forceCpuFailure: new ApiFailure(500, "server.internal_error", {}) });
  expect(refused).toContain('role="alert"');
});

test("a native package has no tool to choose, even where two tools are installed", () => {
  const native: LocalEngineView = {
    ...running,
    installed: { packageVersion: "2.6.0", variant: "linux-amd64-cpu", kind: "native", runtime: null },
    runtime: { chosen: null, available: ["podman", "docker"], preferred: null },
  };
  const html = render({}, native);
  expect(html).not.toContain('type="radio"');
  expect(html).not.toContain("Tool that runs the engine");
  // The limits are still there.
  expect(html).toContain('id="local-memory"');
});
