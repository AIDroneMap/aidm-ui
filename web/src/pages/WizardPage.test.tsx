import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure, setApiBase } from "../api.ts";
import type { CheckLine, MachineCheckView as MachineCheckData } from "../../../shared/api-types.ts";
import en from "../i18n/en.json";
import { textNodes, untranslatedText } from "../test-helpers.ts";
import {
  EngineChoiceScreen,
  InstallScreen,
  finishWizard,
  focusHeading,
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

test("while checking, the button says so and stays focusable: aria-disabled, not disabled", () => {
  const html = renderCheck(refused, { checking: true });
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Checking\.\.\.<\/button>/);
  expect(html).not.toMatch(/(?<!aria-)disabled=/);
});

test("while checking, the status area announces Checking...", () => {
  expect(renderCheck(refused, { checking: true })).toContain('<p role="status" class="visually-hidden">Checking...</p>');
  expect(renderCheck(refused, { checking: true, announcement: "Checked again" })).toContain(
    '<p role="status" class="visually-hidden">Checking...</p>',
  );
});

test("the screen says when the machine was checked, on the clock of this computer", () => {
  const checkedAt = new Date(2026, 9, 26, 14, 5).toISOString();
  const html = renderCheck({ ...refused, checkedAt });
  expect(html).toMatch(/Checked at 02:05\s?PM/);
  expect(renderCheck(null)).not.toContain("Checked at");
  expect(untranslatedText(html, ["12.0 GiB"])).toEqual([]);
});

test("before the first answer the page says it is checking, and a failure shows as an alert", () => {
  expect(renderCheck(null)).toContain("Checking this computer...");
  const html = renderCheck(null, { failure: new ApiFailure(0, "network.unreachable") });
  expect(html).toContain('role="alert"');
});

test("the machine check shows only translated text and data", () => {
  expect(untranslatedText(renderCheck(refused))).toEqual([]);
  expect(untranslatedText(renderCheck(allowed), ["200.0 GiB"])).toEqual([]);
});

function renderChoice(check: MachineCheckData | null, overrides: Partial<Parameters<typeof EngineChoiceScreen>[0]> = {}): string {
  return renderToStaticMarkup(
    <EngineChoiceScreen
      check={check}
      checkFailure={null}
      checking={false}
      busy={false}
      failure={null}
      onCheckAgain={() => {}}
      onInstall={() => {}}
      onRemote={() => {}}
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
  expect(html).toContain(">Add a remote engine</button>");
  expect(html).toContain(">Use AIDM UI without an engine</button>");
});

test("when the local engine is offered, all three options are present", () => {
  const html = renderChoice(allowed);
  expect(html).toContain(">Install on this computer</button>");
  expect(html).toContain(">Add a remote engine</button>");
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

test("a failed save shows next to the choices and busy marks the buttons aria-disabled", () => {
  const html = renderChoice(allowed, { busy: true, failure: new ApiFailure(500, "server.internal_error") });
  expect(html).toContain('role="alert"');
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Use AIDM UI without an engine<\/button>/);
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Add a remote engine<\/button>/);
  expect(html).not.toMatch(/(?<!aria-)disabled=/);
});

test("after a failed machine check the choice screen shows the error and a Check again button", () => {
  const html = renderChoice(null, { checkFailure: new ApiFailure(0, "network.unreachable") });
  expect(html).toContain('role="alert"');
  expect(html).toContain(">Check again</button>");
  expect(html).not.toContain("has not finished checking");
  expect(untranslatedText(html)).toEqual([]);

  const again = renderChoice(null, { checkFailure: new ApiFailure(0, "network.unreachable"), checking: true });
  expect(again).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Checking\.\.\.<\/button>/);
  expect(again).toContain('<p role="status" class="visually-hidden">Checking...</p>');
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
  const sample = renderToStaticMarkup(
    <SampleScreen busy={false} failure={null} onAuthRequired={() => {}} onBack={() => {}} onFinish={() => {}} />,
  );
  for (const html of [welcome, install, sample]) {
    expect(untranslatedText(html)).toEqual([]);
    expect(html).not.toContain("<input");
  }
  expect(welcome).toContain(">Next</button>");
  expect(install).toContain(en["wizard.install.body"]);
  expect(install).toContain(">Back</button>");
  expect(install).toContain(">Next</button>");
  expect(sample).not.toContain('<a href="#/sample"');
  expect(sample).toContain(">Finish</button>");
});

test("the sample screen holds the sample job page itself, with one heading, and Finish below it", () => {
  const html = renderToStaticMarkup(
    <SampleScreen busy={false} failure={null} onAuthRequired={() => {}} onBack={() => {}} onFinish={() => {}} />,
  );
  expect(html.match(/<h1\b/g)?.length).toBe(1);
  expect(html).toContain(en["wizard.sample.body"]);
  expect(html).toContain(en["sample.loading"]);
  expect(html.indexOf(en["wizard.sample.body"])).toBeLessThan(html.indexOf(en["sample.loading"]));
  expect(html.indexOf(en["sample.loading"])).toBeLessThan(html.indexOf(">Finish</button>"));
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

test("a screen heading is focused by id, and a missing heading is no error", () => {
  const focused: string[] = [];
  focusHeading({
    getElementById: (id) => ({ focus: () => void focused.push(id) }) as unknown as HTMLElement,
  });
  expect(focused).toEqual(["wizard-title"]);
  expect(() => focusHeading({ getElementById: () => null })).not.toThrow();
});

let server: ReturnType<typeof Bun.serve>;
let saved: unknown[];
let refuseSave = false;

beforeAll(() => {
  saved = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname === "/api/wizard" && request.method === "PUT") {
        if (refuseSave) return Response.json({ error: { code: "server.internal_error", data: {} } }, { status: 500 });
        saved.push(await request.json());
        return Response.json({ completed: true });
      }
      return new Response(null, { status: 404 });
    },
  });
  setApiBase(`http://127.0.0.1:${server.port}`);
});

afterAll(() => {
  server.stop(true);
  setApiBase("");
});

test("finishing for the remote path saves that the wizard is done, then goes to the engines page", async () => {
  saved.length = 0;
  const moves: string[] = [];
  let completed = 0;
  await finishWizard("#/engines", () => (completed += 1), (hash) => moves.push(hash));
  expect(saved).toEqual([{ completed: true }]);
  expect(completed).toBe(1);
  expect(moves).toEqual(["#/engines"]);
});

test("finishing without an engine goes home, and a failed save moves nowhere", async () => {
  const moves: string[] = [];
  await finishWizard("#/", () => {}, (hash) => moves.push(hash));
  expect(moves).toEqual(["#/"]);

  refuseSave = true;
  let completed = 0;
  await expect(finishWizard("#/engines", () => (completed += 1), (hash) => moves.push(hash))).rejects.toBeInstanceOf(
    ApiFailure,
  );
  refuseSave = false;
  expect(completed).toBe(0);
  expect(moves).toEqual(["#/"]);
});
