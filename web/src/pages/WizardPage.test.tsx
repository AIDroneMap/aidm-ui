import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure, setApiBase } from "../api.ts";
import type {
  CheckLine,
  LocalEngineView,
  MachineCheckView as MachineCheckData,
  PackagesView,
  RuntimeSetupView,
} from "../../../shared/api-types.ts";
import en from "../i18n/en.json";
import { engineInstall, fresh, macInstall, macPlan } from "../localEngine.fixtures.ts";
import { textNodes, unlabelledInputs, untranslatedText } from "../test-helpers.ts";
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

const builtIn: PackagesView = {
  offer: {
    packageVersion: "2.5.0",
    engineVersion: "2.5.0",
    variant: "linux-amd64-cpu",
    kind: "container",
    size: 682533845,
    processorSize: null,
    source: "builtin",
    tag: null,
  },
  gpu: { state: "not_used", reason: null, guideUrl: null },
  reason: null,
  updateCheck: "daily",
  lastCheck: null,
};

const GUIDE = "https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html";

function renderInstall(
  packages: PackagesView | null,
  overrides: Partial<Parameters<typeof InstallScreen>[0]> = {},
): string {
  return renderToStaticMarkup(
    <InstallScreen
      packages={packages}
      failure={null}
      saving={false}
      answeredHere={false}
      announcement=""
      onUpdateCheckChange={() => {}}
      local={null}
      installBusy={false}
      installFailure={null}
      onInstallLocal={() => {}}
      setup={null}
      onRemote={() => {}}
      remoteBusy={false}
      onStopWaiting={() => {}}
      stopWaitingBusy={false}
      onBack={() => {}}
      onNext={() => {}}
      {...overrides}
    />,
  );
}

test("the welcome, install and sample screens are translated and their controls are labelled", () => {
  const welcome = renderToStaticMarkup(<WelcomeScreen onNext={() => {}} />);
  const install = renderInstall(builtIn);
  const sample = renderToStaticMarkup(
    <SampleScreen busy={false} failure={null} onAuthRequired={() => {}} onBack={() => {}} onFinish={() => {}} />,
  );
  for (const html of [welcome, sample]) {
    expect(untranslatedText(html)).toEqual([]);
    expect(html).not.toContain("<input");
  }
  expect(untranslatedText(install, ["2.5.0", "651 MiB"])).toEqual([]);
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

test("the install screen shows the built-in package for this computer in plain words", () => {
  const html = renderInstall(builtIn);
  expect(html).toContain("AIDM engine 2.5.0 for this computer");
  expect(html).toContain("Linux, 64-bit Intel or AMD processor");
  expect(html).toContain("Download size: 651 MiB");
  expect(html).toContain("This information is built into AIDM UI.");
  expect(html).toContain(en["wizard.install.body"]);
});

test("a downloaded package names the release it came from", () => {
  const html = renderInstall({
    ...builtIn,
    offer: { ...builtIn.offer!, packageVersion: "2.6.0", source: "downloaded", tag: "v2.6.0" },
  });
  expect(html).toContain("AIDM engine 2.6.0 for this computer");
  expect(html).toContain("This information is from release v2.6.0.");
  expect(untranslatedText(html, ["2.6.0", "651 MiB", "v2.6.0"])).toEqual([]);
});

test("a native package says it is installed as a program, and a container does not", () => {
  const native = renderInstall({ ...builtIn, offer: { ...builtIn.offer!, packageVersion: "2.6.0", kind: "native" } });
  expect(native).toContain("Installed as a program on this computer");
  expect(renderInstall(builtIn)).not.toContain("Installed as a program on this computer");
  expect(untranslatedText(native, ["2.6.0", "651 MiB"])).toEqual([]);
});

test("an interface that is too old shows both versions and no offer", () => {
  const html = renderInstall({
    ...builtIn,
    offer: null,
    reason: { code: "manifest.update_interface", data: { minimum: "0.4.0", running: "0.3.0" } },
  });
  expect(html).toContain("This engine release needs a newer AIDM UI (0.4.0). You have 0.3.0. Update AIDM UI to install it.");
  expect(html).not.toContain("for this computer");
  expect(html).not.toContain("Download size");
  expect(untranslatedText(html)).toEqual([]);
});

test("a newer release that needs a newer interface keeps the offer and says why the newer one waits", () => {
  const html = renderInstall({
    ...builtIn,
    reason: { code: "manifest.update_interface", data: { minimum: "0.4.0", running: "0.3.0" } },
  });
  expect(html).toContain("AIDM engine 2.5.0 for this computer");
  expect(html).toContain("Download size: 651 MiB");
  expect(html).toContain("This engine release needs a newer AIDM UI (0.4.0). You have 0.3.0. Update AIDM UI to install it.");
  expect(untranslatedText(html, ["2.5.0", "651 MiB", "0.4.0", "0.3.0"])).toEqual([]);
});

test("another reason for no offer shows its sentence, and no reason says there is no package", () => {
  const noVariant = renderInstall({ ...builtIn, offer: null, reason: { code: "manifest.no_variant", data: {} } });
  expect(noVariant).toContain("This engine release has no package for this computer.");
  const none = renderInstall({ ...builtIn, offer: null });
  expect(none).toContain("No engine package is available for this computer.");
});

test("before the packages load the screen says so, and a failure shows as an alert", () => {
  expect(renderInstall(null)).toContain("Looking for an engine package for this computer...");
  const html = renderInstall(null, { failure: new ApiFailure(0, "network.unreachable") });
  expect(html).toContain('role="alert"');
});

test("the update question shows only while the answer is null", () => {
  const asked = renderInstall({ ...builtIn, updateCheck: null });
  expect(asked).toContain("<legend>Check for engine updates once a day?</legend>");
  expect(asked.match(/type="radio"/g)?.length).toBe(2);
  expect(asked).toContain(">Yes, once a day (recommended)</label>");
  expect(asked).toContain(">No, only when I ask</label>");
  expect(asked).toContain(
    "Once a day AIDM UI asks GitHub Releases whether a newer engine exists. That takes a few web requests. They carry no information about you or your projects; GitHub sees your internet address, as with any web page.",
  );
  expect(asked).not.toContain("checked");
  expect(unlabelledInputs(asked)).toEqual([]);
  expect(untranslatedText(asked, ["2.5.0", "651 MiB"])).toEqual([]);

  expect(renderInstall(builtIn)).not.toContain("<fieldset");
  expect(renderInstall(builtIn)).not.toContain("GitHub Releases");
  expect(renderInstall(null)).not.toContain("<fieldset");
});

test("the install screen keeps Back, Next and a status area, and Next needs no answer", () => {
  const html = renderInstall({ ...builtIn, updateCheck: null });
  expect(html).toContain(">Back</button>");
  expect(html).toMatch(/<button type="button">Next<\/button>/);
  expect(html).toContain('<p role="status" class="visually-hidden"></p>');
  expect(renderInstall(builtIn, { announcement: "Your answer is saved." })).toContain(
    '<p role="status" class="visually-hidden">Your answer is saved.</p>',
  );
});

test("while the answer is saving, the radios are marked unavailable but stay in the page", () => {
  const html = renderInstall({ ...builtIn, updateCheck: null }, { saving: true });
  expect(html.match(/aria-disabled="true"/g)?.length).toBe(2);
  expect(html).not.toContain('disabled=""');
});

test("once answered on this screen, the question stays with the saved answer checked", () => {
  const html = renderInstall({ ...builtIn, updateCheck: "never" }, { answeredHere: true });
  expect(html).toContain("<fieldset");
  expect(html).toMatch(/<input[^>]*id="wizard-update-never"[^>]*checked=""/);
  expect(html).not.toMatch(/<input[^>]*id="wizard-update-daily"[^>]*checked=""/);
});

const MIB = 1024 ** 2;

const pulling: LocalEngineView = {
  ...fresh,
  state: "installing",
  install: engineInstall({ size: 683 * MIB, layersDone: 3, layersTotal: 9 }),
};

test("the install screen offers to install on this computer, below the package offer", () => {
  const html = renderInstall(builtIn, { local: fresh });
  expect(html).toContain(">Install on this computer</button>");
  expect(html.indexOf("Download size")).toBeLessThan(html.indexOf("Install on this computer"));
  expect(html).not.toContain("comes in a later version");
  expect(html).toContain(">Next</button>");
  expect(untranslatedText(html, ["2.5.0", "651 MiB"])).toEqual([]);
  // Before the server has answered, the button is already there.
  expect(renderInstall(builtIn)).toContain(">Install on this computer</button>");
  // Without an offer there is nothing to install.
  expect(renderInstall({ ...builtIn, offer: null })).not.toContain("Install on this computer");
});

test("while the request to install is on its way the button is busy but keeps focus", () => {
  const html = renderInstall(builtIn, { local: fresh, installBusy: true });
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain(">Installing...</button>");
});

test("during the download the screen shows the size and the parts, and Next stays", () => {
  const html = renderInstall(builtIn, { local: pulling });
  expect(html).toContain("Downloading the engine: 683 MiB");
  expect(html).toContain("3 of 9 parts");
  expect(html).toContain(">Installing...</button>");
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain(">Next</button>");
  expect(untranslatedText(html, ["2.5.0", "651 MiB"])).toEqual([]);
});

test("with unknown parts the screen shows an indeterminate progress bar", () => {
  const html = renderInstall(builtIn, {
    local: { ...pulling, install: { ...pulling.install!, layersDone: null, layersTotal: null } },
  });
  expect(html).toContain('<progress id="install-progress"></progress>');
  expect(html).not.toContain("parts");
});

test("the screen says when the engine starts and when it is ready", () => {
  const starting = renderInstall(builtIn, {
    local: { ...pulling, state: "starting", install: { ...pulling.install!, phase: "starting" } },
  });
  expect(starting).toContain("Starting the engine");
  const installed = { packageVersion: "2.5.0", variant: "linux-amd64-cpu", kind: "container", runtime: "podman" } as const;
  const ready = renderInstall(builtIn, {
    local: { ...pulling, state: "ready", installed, install: { ...pulling.install!, phase: "done" } },
  });
  expect(ready).toContain("The engine is ready");
  expect(ready).toContain(">Installed on this computer</button>");
});

test("a refusal for lack of disk space shows what is needed and what is free in GiB", () => {
  const html = renderInstall(builtIn, {
    local: fresh,
    installFailure: new ApiFailure(409, "install.not_enough_space", { needed: 8 * 1024 * MIB, free: 2.5 * 1024 * MIB }),
  });
  expect(html).toContain('role="alert"');
  expect(html).toContain("The engine needs 8.0 GiB and this computer has 2.5 GiB free.");
  expect(untranslatedText(html, ["2.5.0", "651 MiB"])).toEqual([]);
});

test("the warning about the memory limit shows on the install screen", () => {
  const html = renderInstall(builtIn, {
    local: { ...pulling, warnings: [{ code: "local.memory_cap_not_enforced", data: {} }] },
  });
  expect(html).toContain("cannot limit the memory the engine uses");
});

// The install of Podman where no container tool works (ticket #12).

const noRuntime: LocalEngineView = { ...fresh, runtime: { chosen: null, available: [], preferred: null } };
const DATA = ["2.5.0", "651 MiB"];

const setupView = (phase: RuntimeSetupView["phase"], problem: RuntimeSetupView["problem"] = null): RuntimeSetupView => ({
  phase,
  problem,
});

test("with no container tool on Linux the install screen keeps one button, Install on this computer, with the explanation of the password prompt above it", () => {
  const html = renderInstall(builtIn, { local: noRuntime });
  expect(html).toContain(">Install on this computer</button>");
  expect(html).not.toContain("Install Podman");
  expect(html.match(/<button[^>]*>Install on this computer<\/button>/g)).toHaveLength(1);
  expect(html).toContain("AIDM UI will install Podman, the free tool that runs the engine.");
  expect(html).toContain("This computer will ask you once for the administrator password.");
  expect(html.indexOf("administrator password")).toBeLessThan(html.indexOf("Install on this computer"));
  expect(html).toContain(">Next</button>");
  expect(untranslatedText(html, DATA)).toEqual([]);
});

// Criterion: when a runtime already works, the setup step is not offered.
test("when a container tool already works nothing about Podman appears", () => {
  const html = renderInstall(builtIn, { local: fresh });
  expect(html).not.toContain("Podman");
  expect(html).not.toContain("administrator password");
  expect(html).toContain(">Install on this computer</button>");
});

test("the setup is not offered without a package, on a computer that is not Linux, or once an engine is installed", () => {
  expect(renderInstall({ ...builtIn, offer: null }, { local: noRuntime })).not.toContain("administrator password");
  const mac = { ...builtIn, offer: { ...builtIn.offer!, variant: "darwin-arm64" as const } };
  expect(renderInstall(mac, { local: noRuntime })).not.toContain("administrator password");
  const installed = { packageVersion: "2.5.0", variant: "linux-amd64-cpu", kind: "container", runtime: "podman" } as const;
  expect(renderInstall(builtIn, { local: { ...noRuntime, installed } })).not.toContain("administrator password");
  // Before the server has said what runs on this computer, there is nothing to offer yet.
  expect(renderInstall(builtIn, { local: null })).not.toContain("administrator password");
});

test.each([
  ["approval", "Waiting for your approval. Enter the administrator password in the window that opened."],
  ["installing", "Still working: installing Podman. This can take several minutes, and it cannot be stopped from here."],
  ["checking", "Checking that Podman works."],
] as const)("while the setup is at %s the screen says so in a status area and the button stays, busy", (phase, words) => {
  const html = renderInstall(builtIn, { local: noRuntime, setup: setupView(phase) });
  expect(html).toContain(`<div role="status"><p>${words}</p></div>`);
  expect(html).toContain("aria-disabled");
  expect(html).toContain(">Installing...</button>");
  expect(html).not.toContain(">Install on this computer</button>");
  expect(untranslatedText(html, DATA)).toEqual([]);
});

test("the status area is present before the setup begins, so that a screen reader hears the first step", () => {
  expect(renderInstall(builtIn, { local: noRuntime })).toContain('<div role="status"></div>');
});

test("while the request to begin is on its way the button is busy", () => {
  const html = renderInstall(builtIn, { local: noRuntime, installBusy: true });
  expect(html).toContain("aria-disabled");
  expect(html).toContain(">Installing...</button>");
});

// Criteria: a dismissed prompt, an unsupported distribution and every other failure end in a message and the remote engine offer.
test.each([
  [{ code: "setup.dismissed", data: {} }, "The password window was closed, so Podman was not installed."],
  [{ code: "setup.not_authorised", data: {} }, "or it had no way to ask for the administrator password."],
  [
    { code: "setup.not_available", data: {} },
    "This computer cannot ask for the administrator password from AIDM UI. Add a remote engine, or install Podman yourself.",
  ],
  [{ code: "setup.unsupported_distribution", data: { id: "gentoo" } }, "this kind of Linux (gentoo)"],
  [{ code: "setup.failed", data: { code: 4 } }, "Podman could not be installed (code 4)."],
  [{ code: "setup.runtime_not_working", data: {} }, "Podman was installed but does not work yet."],
] as const)("the failure %p shows its sentence and the way to a remote engine", (problem, sentence) => {
  const html = renderInstall(builtIn, { local: noRuntime, setup: setupView("failed", problem) });
  expect(html).toContain('role="alert"');
  expect(html).toContain(sentence);
  expect(html).toContain("You can also use an engine that runs on another computer.");
  expect(html).toContain(">Add a remote engine</button>");
  // And the operator can try again with the same button.
  expect(html).toContain(">Install on this computer</button>");
  expect(untranslatedText(html, DATA)).toEqual([]);
});

test("a failure with a tool that works by now still shows the way out, and the engine install is back", () => {
  const html = renderInstall(builtIn, {
    local: fresh,
    setup: setupView("failed", { code: "install.not_offered", data: {} }),
  });
  expect(html).toContain(">Add a remote engine</button>");
  expect(html).toContain(">Install on this computer</button>");
});

test("a refusal of the click shows beside the button", () => {
  const html = renderInstall(builtIn, {
    local: noRuntime,
    installFailure: new ApiFailure(409, "setup.already_running", {}),
  });
  expect(html).toContain("Podman is already being installed.");
});

test("the way out is busy while the end of the wizard is being saved", () => {
  const html = renderInstall(builtIn, { local: noRuntime, setup: setupView("failed", { code: "setup.dismissed", data: {} }), remoteBusy: true });
  expect(html).toMatch(/aria-disabled="true"[^>]*>Add a remote engine</);
});

test("a failed Podman setup and a refused install offer the way to a remote engine once, not twice", () => {
  const both = renderInstall(builtIn, {
    local: noRuntime,
    setup: setupView("failed", { code: "setup.dismissed", data: {} }),
    installFailure: new ApiFailure(409, "setup.already_running", {}),
  });
  expect(both.match(/>Add a remote engine<\/button>/g)).toHaveLength(1);
  const installOnly = renderInstall(builtIn, { local: fresh, installFailure: new ApiFailure(409, "install.no_runtime", {}) });
  expect(installOnly.match(/>Add a remote engine<\/button>/g)).toHaveLength(1);
});

test("the setup text never uses the system's own words", () => {
  for (const [key, text] of Object.entries(en)) {
    if (!key.startsWith("setup.")) continue;
    expect(text, key).not.toMatch(/polkit|pkexec|subuid|subgid|\broot\b|sudo/i);
  }
});

test("a finished setup shows nothing more once the tool works", () => {
  const html = renderInstall(builtIn, { local: fresh, setup: setupView("done") });
  expect(html).not.toContain("Podman");
});

test("the install screen says the engine will use the graphics card when the checks pass", () => {
  const html = renderInstall({ ...builtIn, gpu: { state: "used", reason: null, guideUrl: null } });
  expect(html).toContain(en["wizard.install.gpu.used"]);
  expect(html).not.toContain("<a ");
  expect(untranslatedText(html, ["2.5.0", "651 MiB"])).toEqual([]);
});

test("the install screen gives the one reason and a plain link when the card cannot be used", () => {
  const html = renderInstall({
    ...builtIn,
    gpu: {
      state: "not_used",
      reason: { code: "gpu.no_passthrough", data: { runtime: "docker", guideUrl: GUIDE } },
      guideUrl: GUIDE,
    },
  });
  expect(html).toContain(en["gpu.no_passthrough"]);
  expect(html).toContain(`<a href="${GUIDE}" target="_blank" rel="noreferrer noopener">How to set up the NVIDIA Container Toolkit</a>`);
  expect(html).not.toContain(en["wizard.install.gpu.used"]);
  expect(untranslatedText(html, ["2.5.0", "651 MiB"])).toEqual([]);
});

test("the install screen says nothing about the graphics card on a computer without one, or where it is not checked", () => {
  for (const gpu of [
    { state: "not_used", reason: null, guideUrl: null },
    { state: "not_checked", reason: null, guideUrl: null },
  ] as const) {
    const html = renderInstall({ ...builtIn, gpu });
    expect(html).not.toContain("graphics card");
    expect(html).not.toContain("<a ");
  }
});

test("forcing the processor shows its reason without a link", () => {
  const html = renderInstall({
    ...builtIn,
    gpu: { state: "not_used", reason: { code: "gpu.forced_cpu", data: {} }, guideUrl: null },
  });
  expect(html).toContain(en["gpu.forced_cpu"]);
  expect(html).not.toContain("<a ");
});

test("a link that is not https is not shown", () => {
  const html = renderInstall({
    ...builtIn,
    gpu: {
      state: "not_used",
      reason: { code: "gpu.in_image_failed", data: { guideUrl: "javascript:alert(1)" } },
      guideUrl: "javascript:alert(1)",
    },
  });
  expect(html).toContain(en["gpu.in_image_failed"]);
  expect(html).not.toContain("<a ");
});

const graphicsOffer: PackagesView = {
  ...builtIn,
  offer: { ...builtIn.offer!, variant: "linux-amd64-gpu", size: 5_678_958_647, processorSize: 682_533_845 },
  gpu: { state: "used", reason: null, guideUrl: null },
};

test("before the graphics card package is downloaded the screen gives its size and what happens if the test run fails", () => {
  const html = renderInstall(graphicsOffer, { local: fresh });
  expect(html).toContain(
    "The download is the graphics card package, 5.3 GiB. If the test run inside it fails, AIDM UI deletes it and downloads the processor package instead, 651 MiB.",
  );
  expect(html.indexOf("The download is the graphics card package")).toBeLessThan(html.indexOf("Install on this computer"));
  expect(untranslatedText(html, ["2.5.0", "651 MiB"])).toEqual([]);
});

test("the processor package alone gets no such sentence, and without a size the sentence stops short", () => {
  expect(renderInstall({ ...graphicsOffer, offer: { ...builtIn.offer! }, gpu: { state: "used", reason: null, guideUrl: null } })).not.toContain(
    "The download is the graphics card package",
  );
  const html = renderInstall({ ...graphicsOffer, offer: { ...graphicsOffer.offer!, processorSize: null } });
  expect(html).toContain("downloads the processor package instead.");
});

test("the button stays busy during the test run and the deletion of the graphics card package", () => {
  for (const phase of ["checking_gpu", "removing_gpu_package"] as const) {
    const html = renderInstall(graphicsOffer, {
      local: { ...pulling, install: { ...pulling.install!, phase, variant: "linux-amd64-gpu", size: 5_678_958_647 } },
    });
    expect(html).toContain(">Installing...</button>");
  }
});

// The Mac path.

const macCheck = (code: "machine.mac_intel" | "machine.macos_too_old", data = {}): MachineCheckData => ({
  lines: [{ id: "platform", result: "fail", message: { code, data } }],
  localEngine: { offered: false, reason: { code, data } },
  checkedAt: "2026-10-26T10:00:00Z",
});

test("on an Intel Mac the choice screen does not offer the local engine, says why, and offers a remote engine", () => {
  const html = renderChoice(macCheck("machine.mac_intel"));
  expect(html).not.toContain("Install on this computer</button>");
  expect(html).toContain("this Mac has an Intel processor");
  expect(html).toContain(">Add a remote engine</button>");
  expect(untranslatedText(html)).toEqual([]);
});

test("on macOS 15 the choice screen says which macOS is needed and offers a remote engine", () => {
  const html = renderChoice(macCheck("machine.macos_too_old", { version: "15.6.1", minimumVersion: 26 }));
  expect(html).not.toContain("Install on this computer</button>");
  expect(html).toContain("The engine needs macOS 26 or newer.");
  expect(html).toContain(">Add a remote engine</button>");
  expect(untranslatedText(html)).toEqual([]);
});

test("the install screen on a Mac lists the steps with their sizes before the operator clicks", () => {
  const html = renderInstall(builtIn, { local: { ...fresh, plan: macPlan } });
  const order = [
    "Apple&#x27;s container tool, 149 MiB",
    "Your approval: macOS asks for your password once",
    "Starting Apple&#x27;s container tool",
    "Kernel, 664 MiB",
    "Startup files, 66 MiB",
    "AIDM engine, 594 MiB",
  ].map((text) => html.indexOf(text));
  expect(order.every((index) => index > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(html.indexOf("Install on this computer</button>")).toBeGreaterThan(0);
  expect(untranslatedText(html, ["2.5.0", "651 MiB"])).toEqual([]);
});

test("the install screen marks the current Mac step and keeps the button busy", () => {
  const html = renderInstall(builtIn, { local: { ...fresh, state: "installing", plan: macPlan, install: macInstall("approve") } });
  expect(html).toContain('<li aria-current="step"');
  expect(html).toContain(">Installing...</button>");
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Installing\.\.\.<\/button>/);
});

test("a failed Mac step shows its message and a button to add a remote engine", () => {
  const html = renderInstall(builtIn, {
    local: {
      ...fresh,
      state: "failed",
      plan: macPlan,
      install: macInstall("approve", { phase: "failed" }),
      problem: { code: "mac.install_not_finished", data: { reason: "timeout" } },
    },
  });
  expect(html).toContain("Apple&#x27;s container tool was not installed.");
  expect(html).toContain("You can use an engine on another computer instead.");
  expect(html).toContain(">Add a remote engine</button>");
  expect(untranslatedText(html, ["2.5.0", "651 MiB"])).toEqual([]);
});

test("a download that stalled ends the install with why, keeps what arrived, and offers a remote engine", () => {
  const html = renderInstall(builtIn, {
    local: {
      ...fresh,
      state: "failed",
      install: engineInstall({ phase: "failed", size: 683 * MIB, stepReceived: 300 * MIB }),
      problem: { code: "install.pull_failed", data: { cause: { code: "download.stalled", data: { seconds: 300 } } } },
    },
  });
  expect(html).toContain("The engine could not be downloaded.");
  expect(html).toContain("Nothing arrived for 300 seconds, so the download stopped. What arrived so far is kept: try again when the connection works.");
  expect(html).toContain("You can use an engine on another computer instead.");
  expect(html).toContain(">Add a remote engine</button>");
  expect(untranslatedText(html, ["2.5.0", "651 MiB"])).toEqual([]);
});

test("while the page waits for the password, it offers a remote engine and a Stop waiting button", () => {
  const html = renderInstall(builtIn, { local: { ...fresh, state: "installing", plan: macPlan, install: macInstall("approve") } });
  expect(html).toContain("You can use an engine on another computer instead.");
  expect(html).toContain(">Add a remote engine</button>");
  expect(html).toMatch(/<button type="button"[^>]*>Stop waiting<\/button>/);
  expect(untranslatedText(html, ["2.5.0", "651 MiB"])).toEqual([]);
});

test("Stop waiting is shown only while the approval is awaited", () => {
  for (const step of ["installer", "service", "kernel", "init", "engine"] as const) {
    const html = renderInstall(builtIn, { local: { ...fresh, state: "installing", plan: macPlan, install: macInstall(step) } });
    expect(html, step).not.toContain("Stop waiting");
    expect(html, step).not.toContain("Add a remote engine");
  }
  const failed = renderInstall(builtIn, {
    local: { ...fresh, state: "failed", plan: macPlan, install: macInstall("approve", { phase: "failed" }), problem: { code: "mac.install_not_finished", data: { reason: "cancelled" } } },
  });
  expect(failed).not.toContain("Stop waiting");
  expect(failed).toContain(">Add a remote engine</button>");
});

test("Stop waiting is busy, with keyboard focus kept, while the request is on its way", () => {
  const html = renderInstall(builtIn, {
    local: { ...fresh, state: "installing", plan: macPlan, install: macInstall("approve") },
    stopWaitingBusy: true,
  });
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Stopping\.\.\.<\/button>/);
});

test("a refusal of the install, such as an Intel Mac, also offers the remote engine", () => {
  const html = renderInstall(builtIn, {
    local: fresh,
    installFailure: new ApiFailure(409, "machine.mac_intel"),
  });
  expect(html).toContain("this Mac has an Intel processor");
  expect(html).toContain(">Add a remote engine</button>");
  expect(renderInstall(builtIn, { local: fresh })).not.toContain("Add a remote engine");
});

test("the remote engine button is busy, with keyboard focus kept, while the wizard is saved", () => {
  const html = renderInstall(builtIn, {
    local: fresh,
    installFailure: new ApiFailure(409, "machine.mac_intel"),
    remoteBusy: true,
  });
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Add a remote engine<\/button>/);
});
