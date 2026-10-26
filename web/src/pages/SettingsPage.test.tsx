import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../api.ts";
import type { SettingsView as SettingsData } from "../../../shared/api-types.ts";
import { untranslatedText, unlabelledInputs } from "../test-helpers.ts";
import { SettingsView, type SettingsViewProps } from "./SettingsPage.tsx";

const lanOff: SettingsData = { port: null, listeningPort: 8823, lan: { enabled: false, addresses: [] } };

function render(overrides: Partial<SettingsViewProps> = {}, settings: SettingsData | null = lanOff): string {
  const props: SettingsViewProps = {
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
    ...overrides,
  };
  return renderToStaticMarkup(<SettingsView {...props} />);
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
