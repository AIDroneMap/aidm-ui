import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../api.ts";
import en from "../i18n/en.json";
import { ENGINE_STATES, type EngineInfoView, type EngineTestView, type EngineView } from "../../../shared/api-types.ts";
import { untranslatedText, unlabelledInputs } from "../test-helpers.ts";
import { EngineForm, EngineList, EnginesPage, type EngineFormProps, type EngineListProps } from "./EnginesPage.tsx";

const info: EngineInfoView = {
  version: "2.6.0",
  engineVersion: "3.5.1",
  cpuCores: 16,
  totalMemory: 64895025152,
  availableMemory: 32000000000,
  queueCount: 3,
  maxParallelTasks: 2,
};

const engine: EngineView = {
  id: 1,
  kind: "remote",
  name: "Barn engine",
  address: "http://192.168.1.20:3000",
  enabled: true,
  state: "ready",
  supported: true,
  info,
  problem: null,
  warning: null,
};

const data = [engine.name, engine.address, "2.6.0", "3.5.1", "16", "3", "Old engine", "https://old.example.com"];

function renderList(engines: EngineView[], overrides: Partial<EngineListProps> = {}): string {
  return renderToStaticMarkup(
    <EngineList
      engines={engines}
      askingToRemove={null}
      onEdit={() => {}}
      onSetEnabled={() => {}}
      onAskRemove={() => {}}
      onConfirmRemove={() => {}}
      onKeep={() => {}}
      {...overrides}
    />,
  );
}

function renderForm(overrides: Partial<EngineFormProps> = {}): string {
  return renderToStaticMarkup(
    <EngineForm
      mode="add"
      name=""
      address=""
      token=""
      onNameChange={() => {}}
      onAddressChange={() => {}}
      onTokenChange={() => {}}
      test={null}
      failure={null}
      testing={false}
      saving={false}
      onTest={() => {}}
      onSave={() => {}}
      onCancel={() => {}}
      {...overrides}
    />,
  );
}

function buttonsHaveNames(html: string): boolean {
  return [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].every(
    (match) => /aria-label="[^"]+"/.test(match[0]) || (match[1] ?? "").replace(/<[^>]*>/g, "").trim() !== "",
  );
}

test("an engine with info shows its versions, cores, memory in GiB and queue", () => {
  const html = renderList([engine]);
  expect(html).toContain("Barn engine");
  expect(html).toContain("API version 2.6.0");
  expect(html).toContain("Engine version 3.5.1");
  expect(html).toContain("CPU cores: 16");
  expect(html).toContain("60.4 GiB");
  expect(html).toContain("Work waiting or running: 3");
  expect(html).toContain("Ready");
  expect(html).not.toContain("Not supported");
  expect(untranslatedText(html, data)).toEqual([]);
  expect(buttonsHaveNames(html)).toBe(true);
});

test("every state has words", () => {
  for (const state of ENGINE_STATES) {
    expect((en as Record<string, string>)[`engine.state.${state}`], state).toBeTruthy();
    const html = renderList([{ ...engine, state, info: null }]);
    expect(html).toContain(`State: ${(en as Record<string, string>)[`engine.state.${state}`]}`);
    expect(untranslatedText(html, data)).toEqual([]);
  }
});

test("an unsupported engine says so, with the versions filled in", () => {
  const old: EngineView = { ...engine, name: "Old engine", supported: false, info: { ...info, version: "2.4.0" } };
  const html = renderList([old]);
  expect(html).toContain("Not supported");
  expect(html).toContain("This engine uses API version 2.4.0. AIDM UI needs 2.5.0 or newer.");
  expect(untranslatedText(html, [...data, "2.4.0"])).toEqual([]);
});

test("a problem from the engine shows the engine's own message", () => {
  const message = "Invalid authentication token: token does not match.";
  const bad: EngineView = {
    ...engine,
    state: "failed",
    info: null,
    problem: { code: "engine.error", data: { message } },
  };
  const html = renderList([bad]);
  expect(html).toContain("The engine refused the request.");
  expect(html).toContain(message);
  expect(untranslatedText(html, [...data, message])).toEqual([]);
});

test("a warning shows under the engine", () => {
  const warned: EngineView = { ...engine, warning: { code: "engine.plain_http_local", data: {} } };
  expect(renderList([warned])).toContain("This address uses plain HTTP. Use it only on a network you trust.");
});

test("a disabled engine says Disabled and offers Enable", () => {
  const html = renderList([{ ...engine, enabled: false }]);
  expect(html).toContain("Disabled");
  expect(html).toContain('aria-label="Enable Barn engine"');
  expect(html).not.toContain(">Disable<");
});

test("removing asks first, inline, with Remove and Keep", () => {
  const asking = renderList([engine], { askingToRemove: 1 });
  expect(asking).toContain("Remove Barn engine?");
  expect(asking).toContain(">Remove<");
  expect(asking).toContain(">Keep<");
  expect(asking).not.toContain(">Edit<");
  expect(buttonsHaveNames(asking)).toBe(true);
  expect(untranslatedText(asking, data)).toEqual([]);

  const idle = renderList([engine]);
  expect(idle).not.toContain("Keep");
  expect(idle).toContain(">Edit<");
});

test("with no engines, the list says so", () => {
  expect(renderList([])).toContain("No engine has been added yet.");
});

test("the form labels every input and hides the token", () => {
  const html = renderForm();
  expect(html).toContain('<label for="engine-name">Name</label>');
  expect(html).toContain('<label for="engine-address">Address</label>');
  expect(html).toContain('<label for="engine-token">Token</label>');
  expect(html).toMatch(/<input id="engine-token" type="password"/);
  expect(html).toContain('autoComplete="off"');
  expect(html).toContain("For example https://engine.example.com or http://192.168.1.20:3000");
  expect(html).toContain("Test connection");
  expect(unlabelledInputs(html)).toEqual([]);
  expect(buttonsHaveNames(html)).toBe(true);
  expect(untranslatedText(html)).toEqual([]);
});

test("a test result shows what the engine reported", () => {
  const test: EngineTestView = {
    info,
    supported: true,
    warning: { code: "engine.plain_http_local", data: {} },
  };
  const html = renderForm({ test });
  expect(html).toContain("The engine answered.");
  expect(html).toContain("API version 2.6.0");
  expect(html).toContain("CPU cores: 16");
  expect(html).toContain("60.4 GiB");
  expect(html).toContain("Work waiting or running: 3");
  expect(html).toContain("This address uses plain HTTP.");
  expect(untranslatedText(html, data)).toEqual([]);
});

test("a test of an unsupported engine shows the label", () => {
  const html = renderForm({ test: { info: { ...info, version: "2.4.0" }, supported: false, warning: null } });
  expect(html).toContain("Not supported");
  expect(html).toContain("needs 2.5.0 or newer");
});

test("edit mode says that an empty token keeps the saved one", () => {
  const edit = renderForm({ mode: "edit" });
  expect(edit).toContain("Leave it empty to keep the saved token.");
  expect(edit).toContain("Edit the engine");
  expect(renderForm()).not.toContain("Leave it empty");
});

test("editing with no token typed cannot test, adding can", () => {
  expect(renderForm({ mode: "edit" })).toMatch(/<button type="button" class="secondary" disabled="">Test connection/);
  expect(renderForm({ mode: "edit", token: "x" })).not.toMatch(/disabled=""[^>]*>Test connection/);
  expect(renderForm()).not.toMatch(/disabled=""[^>]*>Test connection/);
});

test("a refused plain HTTP address shows its text and marks the address", () => {
  const html = renderForm({ failure: new ApiFailure(400, "engine.https_required"), address: "http://example.com" });
  expect(html).toContain('role="alert"');
  expect(html).toContain("This address needs https://.");
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('aria-describedby="engine-address-hint engine-form-error"');
  expect(untranslatedText(html, ["http://example.com"])).toEqual([]);
});

test("an error from the engine shows the engine's message in the form", () => {
  const message = "Invalid authentication token: token does not match.";
  const html = renderForm({ failure: new ApiFailure(400, "engine.error", { message }) });
  expect(html).toContain("The engine refused the request.");
  expect(html).toContain(`The engine answered with an error: ${message}`);
  expect(untranslatedText(html, [message])).toEqual([]);
});

test("while testing and saving, the buttons say so and are off", () => {
  const html = renderForm({ testing: true });
  expect(html).toContain("Testing...");
  expect(renderForm({ saving: true })).toContain("Saving...");
});

test("a disabled engine shows the last state it had, not a current one", () => {
  const html = renderList([{ ...engine, enabled: false, state: "busy" }]);
  expect(html).toContain("Last known state: Busy");
  expect(html).not.toContain("State: Busy");
  expect(renderList([{ ...engine, state: "busy" }])).toContain("State: Busy");
  expect(untranslatedText(html, data)).toEqual([]);
});

test("a failed engine is not working, and the problem line says why", () => {
  const html = renderList([
    { ...engine, state: "failed", problem: { code: "engine.error", data: { message: "Invalid authentication token" } } },
  ]);
  expect(html).toContain("State: Not working");
  expect(html).toContain("Invalid authentication token");
});

test("a new address in edit mode makes the token required and says so", () => {
  const changed = renderForm({ mode: "edit", savedAddress: "http://192.168.1.20:3000", address: "http://192.168.1.21:3000" });
  expect(changed).toMatch(/<input id="engine-token"[^>]*required=""/);
  expect(changed).toContain("Type the token again when you change the address.");
  expect(changed).not.toContain("Leave it empty");

  const same = renderForm({ mode: "edit", savedAddress: "http://192.168.1.20:3000/", address: "http://192.168.1.20:3000" });
  expect(same).not.toMatch(/<input id="engine-token"[^>]*required/);
  expect(same).toContain("Leave it empty to keep the saved token.");

  expect(renderForm({ address: "http://192.168.1.21:3000" })).not.toMatch(/<input id="engine-token"[^>]*required/);
});

test("the page has a quiet status area for state changes and a heading that can take focus", () => {
  const html = renderToStaticMarkup(<EnginesPage onAuthRequired={() => {}} />);
  expect(html).toContain('<h1 tabindex="-1">Engines</h1>');
  expect(html).toMatch(/<p role="status" class="visually-hidden"><\/p>/);
});

const local: EngineView = {
  id: 2,
  kind: "local",
  name: "local",
  address: "http://127.0.0.1:41873",
  enabled: true,
  state: "ready",
  supported: true,
  info,
  problem: null,
  warning: null,
};

test("the local engine is called This computer and has no Edit and no Remove", () => {
  const html = renderList([engine, local]);
  expect(html).toContain("<h2>This computer</h2>");
  expect(html).not.toContain(">local<");
  const entry = html.split('<li class="engine">')[2] ?? "";
  expect(entry).toContain("This computer");
  expect(entry).not.toContain(">Edit<");
  expect(entry).not.toContain(">Remove<");
  expect(entry).not.toContain("aria-label=\"Edit");
  expect(entry).not.toContain("aria-label=\"Remove");
  // The remote engine keeps both.
  const remote = html.split('<li class="engine">')[1] ?? "";
  expect(remote).toContain(">Edit<");
  expect(remote).toContain(">Remove<");
  expect(untranslatedText(html, [...data, local.address])).toEqual([]);
  expect(buttonsHaveNames(html)).toBe(true);
});

test("the local engine says it is a program on this computer when its package is native", () => {
  expect(renderList([local], { localKind: "native" })).toContain("<p>Installed as a program on this computer</p>");
  expect(renderList([local], { localKind: "container" })).not.toContain("Installed as a program");
  expect(renderList([local])).not.toContain("Installed as a program");
  // A remote engine never says it.
  expect(renderList([engine], { localKind: "native" })).not.toContain("Installed as a program");
});

test("the local engine has a toggle for its log, closed at first", () => {
  const closed = renderList([local], { log: { open: false, lines: [], onToggle: () => {} } });
  expect(closed).toContain(">Show the engine log</button>");
  expect(closed).toContain('aria-controls="engine-log"');
  expect(closed).not.toContain("<pre");
  // A remote engine has none.
  expect(renderList([engine], { log: { open: false, lines: [], onToggle: () => {} } })).not.toContain("engine log");
});

test("the open log panel is a labelled region that can take focus and shows the lines it is given", () => {
  const lines = ["starting the engine", "listening on port 3000"];
  const html = renderList([local], { log: { open: true, lines, onToggle: () => {} } });
  expect(html).toContain(">Hide the engine log</button>");
  expect(html).toMatch(/<pre id="engine-log"[^>]*tabindex="0"/);
  expect(html).toContain('role="region"');
  expect(html).toContain('aria-label="Engine log"');
  expect(html).toContain("starting the engine\nlistening on port 3000");
  expect(untranslatedText(html, [...data, local.address, lines.join("\n")])).toEqual([]);
});

test("an open log with no lines yet says so", () => {
  const html = renderList([local], { log: { open: true, lines: [], onToggle: () => {} } });
  expect(html).toContain("The engine has not written anything yet.");
});

test("the local engine shows its state without a Disabled badge when it is switched off", () => {
  const off: EngineView = { ...local, enabled: false, state: "stopped" };
  const html = renderList([off]);
  expect(html).toContain("State: Stopped");
  expect(html).not.toContain("Last known state");
  expect(html).not.toContain("Disabled");
  // A remote engine that is disabled keeps both.
  const remote = renderList([{ ...engine, enabled: false }]);
  expect(remote).toContain("Last known state: Ready");
  expect(remote).toContain("Disabled");
});

test("the switch of the local engine is shown in the local entry only", () => {
  const html = renderList([engine, local], { localSwitch: <p>the switch</p> });
  expect(html.split('<li class="engine">')[2]).toContain("the switch");
  expect(html.split('<li class="engine">')[1]).not.toContain("the switch");
});

test("while the checks on a Mac explain why the local engine cannot be reached, the general note is left out", () => {
  const local: EngineView = { ...engine, kind: "local", name: "This computer", state: "unreachable", problem: { code: "engine.unreachable", data: {} } };
  expect(renderList([local])).toContain("No engine answered at this address.");
  const html = renderList([local], { localDiagnosed: true, localConnection: <p>the diagnosis</p> });
  expect(html).not.toContain("No engine answered at this address.");
  expect(html).toContain("the diagnosis");
  // A remote engine keeps its note.
  expect(renderList([{ ...engine, state: "unreachable", problem: { code: "engine.unreachable", data: {} } }], { localDiagnosed: true })).toContain("No engine answered");
});
