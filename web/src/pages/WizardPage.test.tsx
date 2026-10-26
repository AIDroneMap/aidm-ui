import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../api.ts";
import type { CheckLine, MachineCheckView as MachineCheckData } from "../../../shared/api-types.ts";
import en from "../i18n/en.json";
import { textNodes, untranslatedText } from "../test-helpers.ts";
import {
  EngineChoiceScreen,
  InstallScreen,
  MachineCheckScreen,
  SampleScreen,
  StepIndicator,
  WelcomeScreen,
} from "./WizardPage.tsx";

const GIB = 1024 ** 3;

const passLine = (id: CheckLine["id"], code: CheckLine["message"]["code"], data = {}): CheckLine => ({
  id,
  result: "pass",
  message: { code, data },
});

const lines: CheckLine[] = [
  passLine("platform", "machine.platform_ok"),
  { id: "cpu", result: "fail", message: { code: "machine.cpu_missing", data: { missing: ["avx2", "fma"] } } },
  { id: "ram", result: "warn", message: { code: "machine.ram_low", data: { total: 12 * GIB, recommended: 16 * GIB } } },
  passLine("disk", "machine.disk_ok", { free: 200 * GIB }),
  { id: "gpu", result: "warn", message: { code: "machine.gpu_none", data: {} } },
  { id: "runtime", result: "fail", message: { code: "machine.runtime_none", data: {} } },
];

const refused: MachineCheckData = {
  lines,
  localEngine: { offered: false, reason: { code: "machine.cpu_missing", data: { missing: ["avx2", "fma"] } } },
  checkedAt: "2026-10-26T10:00:00Z",
};

const allowed: MachineCheckData = {
  lines: lines.map((line) => ({ ...line, result: "pass" as const })),
  localEngine: { offered: true, reason: null },
  checkedAt: "2026-10-26T10:00:00Z",
};

function renderCheck(check: MachineCheckData | null, overrides: Partial<Parameters<typeof MachineCheckScreen>[0]> = {}): string {
  return renderToStaticMarkup(
    <MachineCheckScreen
      check={check}
      failure={null}
      checking={false}
      announcement=""
      onCheckAgain={() => {}}
      onBack={() => {}}
      onNext={() => {}}
      {...overrides}
    />,
  );
}

const checkData = ["12.0 GiB"];

test("a failing processor line shows Fail and the sentence with the missing features", () => {
  const html = renderCheck(refused);
  expect(html).toContain("Fail");
  expect(html).toContain(
    "This computer&#x27;s processor is too old for the engine. It lacks avx2, fma. You can still use an engine on another computer.",
  );
});

test("a memory warning shows the total and the recommended size in GiB", () => {
  const html = renderCheck(refused);
  expect(html).toContain("This computer has 12.0 GiB of memory.");
  expect(html).toContain("normal datasets need 16.0 GiB or a remote engine.");
  expect(html).toContain("Warning");
});

test("every line has a result word and a marker that is not read aloud", () => {
  const html = renderCheck(refused);
  const items = html.match(/<li\b[\s\S]*?<\/li>/g) ?? [];
  expect(items.length).toBe(6);
  for (const item of items) {
    expect(item).toMatch(/>(Pass|Warning|Fail)</);
    expect(item).toContain('class="marker marker-');
    expect(item).toContain('aria-hidden="true"');
  }
  expect(renderCheck(allowed).match(/>Pass</g)?.length).toBe(6);
});

test("the machine check has Check again, Back, Next and a status area that is always present", () => {
  const html = renderCheck(refused);
  expect(html).toContain(">Check again</button>");
  expect(html).toContain(">Back</button>");
  expect(html).toContain(">Next</button>");
  expect(html).toContain('<p role="status" class="visually-hidden"></p>');
  expect(renderCheck(refused, { announcement: "Checked again" })).toContain(
    '<p role="status" class="visually-hidden">Checked again</p>',
  );
});

test("while checking, the button says so and is disabled", () => {
  const html = renderCheck(refused, { checking: true });
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Checking\.\.\.<\/button>/);
});

test("before the first answer the page says it is checking, and a failure shows as an alert", () => {
  expect(renderCheck(null)).toContain("Checking this computer...");
  const html = renderCheck(null, { failure: new ApiFailure(0, "network.unreachable") });
  expect(html).toContain('role="alert"');
});

test("the machine check shows only translated text and data", () => {
  expect(untranslatedText(renderCheck(refused), checkData)).toEqual([]);
  expect(untranslatedText(renderCheck(allowed), ["200.0 GiB"])).toEqual([]);
});

function renderChoice(check: MachineCheckData | null, overrides: Partial<Parameters<typeof EngineChoiceScreen>[0]> = {}): string {
  return renderToStaticMarkup(
    <EngineChoiceScreen
      check={check}
      busy={false}
      failure={null}
      onInstall={() => {}}
      onUiOnly={() => {}}
      onBack={() => {}}
      {...overrides}
    />,
  );
}

test("when the local engine is not offered, the install option is absent and the reason shows", () => {
  const html = renderChoice(refused);
  expect(html).not.toContain("Install on this computer");
  expect(html).toContain("It lacks avx2, fma.");
  expect(html).toContain('href="#/engines"');
  expect(html).toContain("Add a remote engine");
  expect(html).toContain(">Use AIDM UI without an engine</button>");
});

test("when the local engine is offered, all three options are present", () => {
  const html = renderChoice(allowed);
  expect(html).toContain(">Install on this computer</button>");
  expect(html).toContain("Add a remote engine");
  expect(html).toContain(">Use AIDM UI without an engine</button>");
  expect(untranslatedText(html)).toEqual([]);
});

test("before the check answers, the install option is absent and the others stay", () => {
  const html = renderChoice(null);
  expect(html).not.toContain("Install on this computer</button>");
  expect(html).toContain("Add a remote engine");
  expect(html).toContain("Use AIDM UI without an engine");
  expect(untranslatedText(html)).toEqual([]);
});

test("a failed save shows next to the choices and busy disables the buttons", () => {
  const html = renderChoice(allowed, { busy: true, failure: new ApiFailure(500, "server.internal_error") });
  expect(html).toContain('role="alert"');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Use AIDM UI without an engine<\/button>/);
});

test("the step indicator is an ordered list that marks the current step", () => {
  const html = renderToStaticMarkup(<StepIndicator step="check" />);
  expect(html).toContain("<ol");
  expect(html.match(/<li/g)?.length).toBe(5);
  expect(html.match(/aria-current="step"/g)?.length).toBe(1);
  expect(html).toMatch(/<li aria-current="step"[^>]*>Machine check<\/li>/);
  expect(textNodes(html)).toContain("Step 2 of 5");
  expect(untranslatedText(html)).toEqual([]);
});

test("the first and last steps are numbered correctly", () => {
  expect(textNodes(renderToStaticMarkup(<StepIndicator step="welcome" />))).toContain("Step 1 of 5");
  expect(textNodes(renderToStaticMarkup(<StepIndicator step="sample" />))).toContain("Step 5 of 5");
});

test("the welcome, install and sample screens are translated and their controls are labelled", () => {
  const welcome = renderToStaticMarkup(<WelcomeScreen onNext={() => {}} />);
  const install = renderToStaticMarkup(<InstallScreen onBack={() => {}} onNext={() => {}} />);
  const sample = renderToStaticMarkup(<SampleScreen busy={false} failure={null} onBack={() => {}} onFinish={() => {}} />);
  for (const html of [welcome, install, sample]) {
    expect(untranslatedText(html)).toEqual([]);
    expect(html).not.toContain("<input");
  }
  expect(welcome).toContain(">Next</button>");
  expect(install).toContain(en["wizard.install.body"]);
  expect(install).toContain(">Back</button>");
  expect(install).toContain(">Next</button>");
  expect(sample).toContain('<a href="#/sample"');
  expect(sample).toContain(">Finish</button>");
});

test("each screen has one heading that can take focus", () => {
  for (const html of [
    renderToStaticMarkup(<WelcomeScreen onNext={() => {}} />),
    renderCheck(refused),
    renderChoice(allowed),
  ]) {
    expect(html.match(/<h1\b/g)?.length).toBe(1);
    expect(html).toContain('tabindex="-1"');
  }
});
