import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/** Engines, Preferences and the wizard, with every part they show, whose controls come from web/src/controls/ only. */
const FILES = [
  "./EnginesPage.tsx",
  "./PreferencesPage.tsx",
  "./WizardPage.tsx",
  "./SampleJobPage.tsx",
  "./ScreenLoading.tsx",
  "../components/BusyButton.tsx",
  "../components/ConnectionHelp.tsx",
  "../components/DownloadBlock.tsx",
  "../components/EngineLog.tsx",
  "../components/ErrorMessage.tsx",
  "../components/GuideLink.tsx",
  "../components/LocalAdvanced.tsx",
  "../components/LocalInstall.tsx",
  "../components/LocalSwitch.tsx",
  "../components/LocalUpdate.tsx",
  "../components/RuntimeSetup.tsx",
  "../components/UpdateCheckQuestion.tsx",
  "../preferences/ThemePreference.tsx",
  "../basemap/BasemapSettings.tsx",
];

/**
 * The raw form controls a file's markup writes, as `file: <tag`. The one
 * exception is a file field hidden from sight, from Tab and from screen
 * readers, which a project button opens, as on the Photos section.
 */
function rawControls(name: string, source: string): string[] {
  return [...source.matchAll(/<(input|select|textarea|button)[\s>/][^>]*>?/g)]
    .filter((match) => !(match[1] === "input" && /type="file"/.test(match[0]) && /className="visually-hidden"/.test(match[0]) && /tabIndex=\{-1\}/.test(match[0]) && /aria-hidden="true"/.test(match[0])))
    .map((match) => `${name}: <${match[1]}`);
}

test("Engines, Preferences and the wizard use the project's controls, never a raw input, select, textarea or button", () => {
  expect(FILES.flatMap((file) => rawControls(file, readFileSync(new URL(file, import.meta.url), "utf8")))).toEqual([]);
});

test("the check finds each raw control, ignores the project's, and lets only a hidden file field opened by a button through", () => {
  const source = [
    '<Button onClick={go}>Go</Button><TextField id="a" label="A" /><RadioGroup name="b" legend="B" options={[]} value={null} onChange={go} />',
    '<input type="checkbox" /><select>\n</select><textarea rows={3} /><button onClick={go}>',
    '<input id="zip" type="file" accept=".zip" />',
    '<input ref={input} id="zip" type="file" className="visually-hidden" tabIndex={-1} aria-hidden="true" accept=".zip" />',
  ].join("\n");
  expect(rawControls("example.tsx", source)).toEqual([
    "example.tsx: <input",
    "example.tsx: <select",
    "example.tsx: <textarea",
    "example.tsx: <button",
    "example.tsx: <input",
  ]);
});
