import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_ID, EXECUTABLE, infoPlist, LAUNCHER, writeApp } from "./macos-app.ts";

const folders: string[] = [];
const pids: number[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "aidm-ui-macos-app-"));
  folders.push(path);
  return path;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the app's Info.plist names the launcher, the version and the bundle identifier", () => {
  const plist = infoPlist("0.1.0");
  expect(plist).toContain("<key>CFBundleExecutable</key>\n  <string>aidm-ui-launcher</string>");
  expect(plist).toContain("<key>CFBundleShortVersionString</key>\n  <string>0.1.0</string>");
  expect(plist).toContain("<key>CFBundleVersion</key>\n  <string>0.1.0</string>");
  expect(plist).toContain(`<key>CFBundleIdentifier</key>\n  <string>${BUNDLE_ID}</string>`);
  expect(plist).toContain("<key>CFBundlePackageType</key>\n  <string>APPL</string>");
  expect(plist).toContain("<key>CFBundleName</key>\n  <string>AIDM UI</string>");
  expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
  expect(plist.trimEnd().endsWith("</plist>")).toBe(true);
});

test("a version that is not three numbers is refused before anything is written", () => {
  const out = folder();
  const executable = join(out, "aidm-ui-macos-arm64");
  writeFileSync(executable, "binary");
  expect(() => writeApp(executable, "v0.1.0", out)).toThrow("1.2.3");
  expect(() => writeApp(executable, "0.1.0\n<key>", out)).toThrow("1.2.3");
  expect(existsSync(join(out, "AIDM UI.app"))).toBe(false);
});

test("the app holds the executable unchanged and the launcher, both runnable", () => {
  const out = folder();
  const executable = join(out, "aidm-ui-macos-arm64");
  writeFileSync(executable, "the compiled server");
  const app = writeApp(executable, "0.1.0", out);
  expect(app).toBe(join(out, "AIDM UI.app"));
  const macos = join(app, "Contents", "MacOS");
  expect(readFileSync(join(macos, EXECUTABLE), "utf8")).toBe("the compiled server");
  expect(statSync(join(macos, EXECUTABLE)).mode & 0o777).toBe(0o755);
  expect(statSync(join(macos, LAUNCHER)).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(app, "Contents", "Info.plist"), "utf8")).toBe(infoPlist("0.1.0"));
  expect(readFileSync(join(app, "Contents", "PkgInfo"), "utf8")).toBe("APPL????");
});

test("writing the app again replaces the older one", () => {
  const out = folder();
  const executable = join(out, "aidm-ui-macos-arm64");
  writeFileSync(executable, "new");
  const app = writeApp(executable, "0.1.0", out);
  writeFileSync(join(app, "Contents", "MacOS", "left-over"), "old");
  writeApp(executable, "0.1.1", out);
  expect(existsSync(join(app, "Contents", "MacOS", "left-over"))).toBe(false);
  expect(readFileSync(join(app, "Contents", "Info.plist"), "utf8")).toContain("<string>0.1.1</string>");
});

test("the launcher starts the executable in the background, with no arguments, and returns at once", async () => {
  const out = folder();
  const record = join(out, "started");
  const executable = join(out, "aidm-ui-macos-arm64");
  // Stands in for the server: it records its pid and arguments, then keeps running.
  writeFileSync(executable, `#!/bin/sh\necho "$$ $#" > "${record}"\nexec sleep 30\n`);
  const app = writeApp(executable, "0.1.0", out);

  const started = Date.now();
  // The pipes close only when no process holds them, so reading them to the end proves the server does not.
  const launcher = Bun.spawn([join(app, "Contents", "MacOS", LAUNCHER)], { cwd: "/", stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(launcher.stdout).text(), new Response(launcher.stderr).text(), launcher.exited]);
  expect(code).toBe(0);
  expect(output + errors).toBe("");
  expect(Date.now() - started).toBeLessThan(5000);

  for (let i = 0; i < 50 && !existsSync(record); i++) await Bun.sleep(100);
  const [pid, argumentCount] = readFileSync(record, "utf8").trim().split(" ").map(Number);
  pids.push(pid as number);
  expect(argumentCount).toBe(0);
  expect(isAlive(pid as number)).toBe(true);
});
