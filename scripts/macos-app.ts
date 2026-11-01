// Wraps the macOS executable in an app that a pilot opens from Finder:
// "AIDM UI.app". It only writes files, so it runs on any system; signing and
// the disk image are made on a Mac (scripts/ci/package-macos.sh).
//
//   bun scripts/macos-app.ts <macOS executable> <version> <output folder>
//
// Opening the app runs a small launcher. The launcher starts the executable
// in the background and exits at once, so that opening the app again starts a
// second copy, which finds the running one, opens the interface in the
// browser again and exits (server/app/start.ts).
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const APP_NAME = "AIDM UI";
export const BUNDLE_ID = "io.github.aidronemap.aidm-ui";
/** The bundle's main executable: the launcher script. */
export const LAUNCHER = "aidm-ui-launcher";
/** The compiled server, next to the launcher. */
export const EXECUTABLE = "aidm-ui";
/** Bun's oldest supported macOS. The Mac engine needs macOS 26; the setup screens say so. */
export const MINIMUM_MACOS = "13.0";

const VERSION = /^\d+\.\d+\.\d+$/;

export function infoPlist(version: string): string {
  if (!VERSION.test(version)) throw new Error(`The version must look like 1.2.3, got "${version}".`);
  const entries: [string, string][] = [
    ["CFBundleDevelopmentRegion", "en"],
    ["CFBundleDisplayName", APP_NAME],
    ["CFBundleExecutable", LAUNCHER],
    ["CFBundleIdentifier", BUNDLE_ID],
    ["CFBundleInfoDictionaryVersion", "6.0"],
    ["CFBundleName", APP_NAME],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleShortVersionString", version],
    ["CFBundleVersion", version],
    ["LSMinimumSystemVersion", MINIMUM_MACOS],
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...entries.flatMap(([key, value]) => [`  <key>${key}</key>`, `  <string>${value}</string>`]),
    "  <key>LSArchitecturePriority</key>",
    "  <array>",
    "    <string>arm64</string>",
    "  </array>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * The launcher. Finder starts apps with no terminal and the working folder
 * "/". The executable's output is dropped: its log is in the data folder.
 */
export const LAUNCHER_SCRIPT = [
  "#!/bin/sh",
  "# Starts AIDM UI in the background and exits. AIDM UI opens its interface in",
  "# the browser, or, when it already runs, opens the running copy's interface.",
  'here=$(cd "$(dirname "$0")" && pwd -P) || exit 1',
  `nohup "$here/${EXECUTABLE}" </dev/null >/dev/null 2>&1 &`,
  "",
].join("\n");

/** Writes "<output folder>/AIDM UI.app", replacing an older one, and returns its path. */
export function writeApp(executable: string, version: string, outputFolder: string): string {
  const plist = infoPlist(version);
  const app = join(outputFolder, `${APP_NAME}.app`);
  rmSync(app, { recursive: true, force: true });
  const macos = join(app, "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), plist);
  writeFileSync(join(app, "Contents", "PkgInfo"), "APPL????");
  copyFileSync(executable, join(macos, EXECUTABLE));
  chmodSync(join(macos, EXECUTABLE), 0o755);
  writeFileSync(join(macos, LAUNCHER), LAUNCHER_SCRIPT);
  chmodSync(join(macos, LAUNCHER), 0o755);
  return app;
}

if (import.meta.main) {
  const [executable, version, outputFolder] = process.argv.slice(2);
  if (executable === undefined || version === undefined || outputFolder === undefined) {
    console.error("usage: bun scripts/macos-app.ts <macOS executable> <version> <output folder>");
    process.exit(2);
  }
  console.log(`Wrote ${writeApp(executable, version, outputFolder)}`);
}
