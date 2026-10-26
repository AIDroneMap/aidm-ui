import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../api.ts";
import type { PackagesView, SettingsView as SettingsData } from "../../../shared/api-types.ts";
import { untranslatedText, unlabelledInputs } from "../test-helpers.ts";
import { SettingsForm, type SettingsFormProps } from "./SettingsPage.tsx";

const lanOff: SettingsData = { port: null, listeningPort: 8823, lan: { enabled: false, addresses: [] } };

const packages: PackagesView = { offer: null, reason: null, updateCheck: "daily", lastCheck: null };

function render(overrides: Partial<SettingsFormProps> = {}, settings: SettingsData | null = lanOff): string {
  const props: SettingsFormProps = {
    settings,
    failure: null,
    saving: null,
    saved: null,
    portDraft: "",
    onPortDraftChange: () => {},
    onSavePort: () => {},
    lanWantsOn: false,
    onLanWantsOnChange: () => {},
    passphrase: "",
    onPassphraseChange: () => {},
    onSaveLan: () => {},
    onTurnLanOff: () => {},
    onRunWizard: () => {},
    packages,
    updateSaving: false,
    updateSaved: false,
    onUpdateCheckChange: () => {},
    refreshing: false,
    refreshResult: null,
    onRefresh: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(<SettingsForm {...props} />);
}

test("with the local network off, the port field is labelled and there is no passphrase field", () => {
  const html = render();
  expect(html).toContain('<label for="settings-port">Port to use</label>');
  expect(html).toContain('id="settings-lan"');
  expect(html).not.toContain('type="password"');
  expect(html).not.toContain("settings-passphrase");
  expect(untranslatedText(html, ["8823"])).toEqual([]);
  expect(unlabelledInputs(html)).toEqual([]);
});

test("the port the server listens on now is shown", () => {
  const html = render({}, { ...lanOff, port: 9000, listeningPort: 8824 });
  expect(html).toContain("listening on port 8824 now");
});

test("turning the local network on shows a labelled passphrase field", () => {
  const html = render({ lanWantsOn: true });
  expect(html).toContain('<label for="settings-passphrase">Passphrase for the network</label>');
  expect(html).toContain('type="password"');
  expect(html).toContain("At least 8 characters");
  expect(unlabelledInputs(html)).toEqual([]);
  expect(untranslatedText(html, ["8823"])).toEqual([]);
});

test("with the local network on, the addresses to open are listed", () => {
  const on: SettingsData = { port: null, listeningPort: 8823, lan: { enabled: true, addresses: ["192.168.1.20"] } };
  const html = render({}, on);
  expect(html).toContain("http://192.168.1.20:8823/");
  expect(html).toContain("Turn off");
  expect(html).not.toContain('type="password"');
  expect(untranslatedText(html, ["8823", "http://192.168.1.20:8823/"])).toEqual([]);
  expect(unlabelledInputs(html)).toEqual([]);
});

test("a port error shows its text with the numbers filled in", () => {
  const failure = new ApiFailure(400, "settings.port_invalid", { min: 1, max: 65535 });
  const html = render({ failure: { section: "port", error: failure }, portDraft: "99999" });
  expect(html).toContain('role="alert"');
  expect(html).toContain("Enter a port between 1 and 65535, or leave it empty.");
  expect(untranslatedText(html, ["8823"])).toEqual([]);
});

test("a passphrase error shows next to the passphrase field", () => {
  const failure = new ApiFailure(400, "settings.passphrase_too_short", { min: 8 });
  const html = render({ failure: { section: "lan", error: failure }, lanWantsOn: true });
  expect(html).toContain("The passphrase needs at least 8 characters.");
});

test("while loading, the page says so", () => {
  const html = render({}, null);
  expect(html).toContain("Loading the settings...");
  expect(untranslatedText(html)).toEqual([]);
});

test("a failed load shows the error", () => {
  const html = render({ failure: { section: "load", error: new ApiFailure(0, "network.unreachable") } }, null);
  expect(html).toContain('role="alert"');
  expect(untranslatedText(html)).toEqual([]);
});

test("each section has a status area that is in the page even when empty, and a save fills it", () => {
  const empty = render();
  expect(empty.match(/<p role="status"><\/p>/g)?.length).toBe(3);

  const portSaved = render({ saved: "port" });
  expect(portSaved).toContain('<p role="status">Port saved.');
  expect(portSaved.match(/role="status"/g)?.length).toBe(3);

  const lanSaved = render({ saved: "lan-off" });
  expect(lanSaved).toContain('<p role="status">AIDM UI is now closed to your local network.</p>');
  expect(lanSaved.match(/role="status"/g)?.length).toBe(3);
});

test("a bad port marks the field invalid and points it at the hint and the error", () => {
  const failure = new ApiFailure(400, "settings.port_invalid", { min: 1, max: 65535 });
  const html = render({ failure: { section: "port", error: failure }, portDraft: "99999" });
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('aria-describedby="settings-port-hint settings-port-error"');
  expect(html).toContain('<p id="settings-port-error" role="alert"');

  const fine = render();
  expect(fine).not.toContain("aria-invalid");
  expect(fine).toContain('aria-describedby="settings-port-hint"');
});

test("the page offers the setup wizard again and a link to the machine check", () => {
  const html = render();
  expect(html).toContain(">Run the setup wizard again</button>");
  expect(html).toContain('<a href="#/wizard/check">Check this computer again</a>');
  expect(untranslatedText(html, ["8823"])).toEqual([]);
});

test("while the wizard opens, its button says so and is disabled", () => {
  const html = render({ saving: "wizard" });
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Opening the wizard\.\.\.<\/button>/);
});

test("a failure to reopen the wizard shows in its own section", () => {
  const failure = new ApiFailure(500, "server.internal_error");
  const html = render({ failure: { section: "wizard", error: failure } });
  expect(html).toContain('role="alert"');
  expect(html.indexOf("Setup wizard")).toBeLessThan(html.indexOf('role="alert"'));
});

test("the engine updates section binds the two radios to the setting and has the refresh button", () => {
  const daily = render();
  expect(daily).toContain("Engine updates");
  expect(daily).toContain("Check for engine updates once a day?");
  expect(daily).toMatch(/<input[^>]*id="settings-update-daily"[^>]*checked=""/);
  expect(daily).not.toMatch(/<input[^>]*id="settings-update-never"[^>]*checked=""/);
  expect(daily).toContain(">Yes, once a day (recommended)</label>");
  expect(daily).toContain(">No, only when I ask</label>");
  expect(daily).toContain("Once a day AIDM UI asks GitHub Releases whether a newer engine exists.");
  expect(daily).toContain("GitHub sees your internet address, as with any web page.");
  expect(daily).toContain(">Look for a newer engine now</button>");
  expect(unlabelledInputs(daily)).toEqual([]);
  expect(untranslatedText(daily, ["8823"])).toEqual([]);

  const never = render({ packages: { ...packages, updateCheck: "never" } });
  expect(never).toMatch(/<input[^>]*id="settings-update-never"[^>]*checked=""/);
  expect(never).not.toMatch(/<input[^>]*id="settings-update-daily"[^>]*checked=""/);

  const unanswered = render({ packages: { ...packages, updateCheck: null } });
  expect(unanswered).not.toContain("checked");
});

test("while the packages load, the radios are disabled", () => {
  const html = render({ packages: null });
  expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  expect(unlabelledInputs(html)).toEqual([]);
});

test("a busy refresh keeps the button in the tab order and marks it unavailable", () => {
  const html = render({ refreshing: true });
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Looking for a newer engine\.\.\.<\/button>/);
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Looking/);
});

test("the refresh result is said in the status area", () => {
  const found = render({ refreshResult: { ok: true, tag: "v2.6.0", replaced: true } });
  expect(found).toContain('<p role="status">Found engine release v2.6.0</p>');
  expect(untranslatedText(found, ["8823", "v2.6.0"])).toEqual([]);

  const none = render({ refreshResult: { ok: true, tag: "v2.5.0", replaced: false } });
  expect(none).toContain('<p role="status">No newer engine release</p>');
});

test("a refresh that failed shows the sentence for its code", () => {
  const html = render({ refreshResult: { ok: false, error: { code: "manifest.signature_invalid", data: {} } } });
  expect(html).toContain("The list of engine releases did not pass the signature check, so AIDM UI did not use it.");
  expect(html).toContain('role="alert"');
});

test("a failed look for releases does not blame the network connection", () => {
  const html = render({ refreshResult: { ok: false, error: { code: "manifest.fetch_failed", data: { step: "discover" } } } });
  expect(html).toContain("AIDM UI could not get the list of engine releases. Try again later.");
  expect(html).not.toContain("connection");
});

test("a failure to save the answer shows in the updates section", () => {
  const failure = new ApiFailure(500, "server.internal_error");
  const html = render({ failure: { section: "updates", error: failure } });
  expect(html).toContain('role="alert"');
  expect(html.indexOf("Engine updates")).toBeLessThan(html.indexOf('role="alert"'));
});

test("a saved answer is said in the status area", () => {
  const html = render({ updateSaved: true });
  expect(html).toContain('<p role="status">Your answer is saved.</p>');
});
