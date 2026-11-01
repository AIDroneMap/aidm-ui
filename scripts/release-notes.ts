// The release notes: the install steps a pilot follows, and nothing else.
//
//   bun scripts/release-notes.ts <version> <signed|unsigned> <file>...
//
// <file> is every file attached to the release. The Mac disk image must be
// one of them; the Linux and Windows lines appear only for the files that are
// there. "unsigned" adds the steps macOS asks for when it cannot check the
// app's developer.

export type MacSigning = "signed" | "unsigned";

export function releaseFiles(version: string) {
  return {
    mac: `aidm-ui-${version}-mac-apple-silicon.dmg`,
    linuxX64: `aidm-ui-${version}-linux-x64`,
    linuxArm64: `aidm-ui-${version}-linux-arm64`,
    windows: `aidm-ui-${version}-windows-x64.exe`,
  };
}

export function releaseNotes(version: string, signing: MacSigning, attached: readonly string[]): string {
  const files = releaseFiles(version);
  if (!attached.includes(files.mac)) throw new Error(`${files.mac} is not attached, and the install steps start with it.`);

  const steps = [
    `Download \`${files.mac}\` from the files below.`,
    "Open it and drag AIDM UI onto Applications.",
    "Open AIDM UI from Applications.",
    ...(signing === "unsigned"
      ? [
          "The Mac says it could not check AIDM UI, and does not open it. Choose Done.",
          "Open System Settings, then Privacy & Security. Scroll down to the line about AIDM UI and choose Open Anyway. Confirm with your password or Touch ID. If the Mac asks once more, choose Open Anyway.",
        ]
      : ["If the Mac asks whether to open an app downloaded from the internet, choose Open."]),
    "Your browser opens AIDM UI. Follow its setup screens. They check the Mac, install the engine and offer a sample job. Nothing is downloaded until you approve it.",
  ];

  const lines = [
    "## Install",
    "",
    "You need a Mac with Apple silicon. The engine on the Mac needs macOS 26 or newer.",
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "To use it again later, open AIDM UI from Applications.",
  ];

  const linux = [files.linuxX64, files.linuxArm64].filter((file) => attached.includes(file));
  if (linux.length > 0) {
    const names = linux.map((file) => `\`${file}\``).join(" or ");
    lines.push("", `On Linux, download ${names} for your processor. Allow the file to run as a program, then open it.`);
  }
  if (attached.includes(files.windows)) {
    lines.push(
      "",
      `On Windows, download \`${files.windows}\` and open it. If Windows says it protected your PC, choose More info, then Run anyway. On Windows, AIDM UI uses an engine on another computer.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const [version, signing, ...attached] = process.argv.slice(2);
  if (version === undefined || (signing !== "signed" && signing !== "unsigned")) {
    console.error("usage: bun scripts/release-notes.ts <version> <signed|unsigned> <file>...");
    process.exit(2);
  }
  process.stdout.write(releaseNotes(version, signing, attached));
}
