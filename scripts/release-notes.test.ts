import { expect, test } from "bun:test";
import { releaseFiles, releaseNotes } from "./release-notes.ts";

const all = Object.values(releaseFiles("0.1.0"));

test("unsigned notes walk the pilot through the macOS approval, in order", () => {
  expect(releaseNotes("0.1.0", "unsigned", all)).toBe(
    [
      "## Install",
      "",
      "You need a Mac with Apple silicon. The engine on the Mac needs macOS 26 or newer.",
      "",
      "1. Download `aidm-ui-0.1.0-mac-apple-silicon.dmg` from the files below.",
      "2. Open it and drag AIDM UI onto Applications.",
      "3. Open AIDM UI from Applications.",
      "4. The Mac says it could not check AIDM UI, and does not open it. Choose Done.",
      "5. Open System Settings, then Privacy & Security. Scroll down to the line about AIDM UI and choose Open Anyway. Confirm with your password or Touch ID. If the Mac asks once more, choose Open Anyway.",
      "6. Your browser opens AIDM UI. Follow its setup screens. They check the Mac, install the engine and offer a sample job. Nothing is downloaded until you approve it.",
      "",
      "To use it again later, open AIDM UI from Applications.",
      "",
      "On Linux, download `aidm-ui-0.1.0-linux-x64` or `aidm-ui-0.1.0-linux-arm64` for your processor. Allow the file to run as a program, then open it.",
      "",
      "On Windows, download `aidm-ui-0.1.0-windows-x64.exe` and open it. If Windows says it protected your PC, choose More info, then Run anyway. On Windows, AIDM UI uses an engine on another computer.",
      "",
    ].join("\n"),
  );
});

test("signed notes have no System Settings step", () => {
  const notes = releaseNotes("0.1.0", "signed", all);
  expect(notes).not.toContain("Privacy & Security");
  expect(notes).toContain("4. If the Mac asks whether to open an app downloaded from the internet, choose Open.\n5. Your browser opens AIDM UI.");
});

test("a platform that was not built is left out of the notes", () => {
  const files = releaseFiles("0.1.0");
  const notes = releaseNotes("0.1.0", "unsigned", [files.mac, files.linuxArm64]);
  expect(notes).toContain("On Linux, download `aidm-ui-0.1.0-linux-arm64` for your processor.");
  expect(notes).not.toContain("linux-x64");
  expect(notes).not.toContain("Windows");
  expect(releaseNotes("0.1.0", "unsigned", [files.mac])).not.toContain("On Linux");
});

test("notes without the Mac disk image are refused", () => {
  expect(() => releaseNotes("0.1.0", "unsigned", [releaseFiles("0.1.0").linuxX64])).toThrow("aidm-ui-0.1.0-mac-apple-silicon.dmg is not attached");
});

test("the notes use no em dash", () => {
  expect(releaseNotes("0.1.0", "unsigned", all)).not.toContain("—");
  expect(releaseNotes("0.1.0", "signed", all)).not.toContain("—");
});
