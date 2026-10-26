// The Mac as the first real test left it: Apple's container tool 1.6.1 is
// installed, its kernel and its startup files are in place, the data folder
// holds a database and the downloaded installer, and there is no engine image.
// Whether the tool's service runs or not (after a reboot it does not), the
// install goes straight to the engine: no installer, no password, no kernel,
// and nothing that stops, removes or resets the tool, its kernel or its images.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { LocalEngineView } from "../../shared/api-types.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { macInputs, recordedMachine } from "../../test-support/recorded-machine.ts";
import { ScriptedRunner, recorded } from "../../test-support/scripted-runner.ts";
import { openDatabase } from "../db/database.ts";
import { applyMigrations, migrations } from "../db/migrations.ts";
import { APPLE_CONTAINER_INIT_IMAGE } from "../runtimes/apple-container-installer.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

const GiB = 1024 ** 3;
const TOOL = "/usr/local/bin/container";
const START = [TOOL, "system", "start", "--disable-kernel-install"];
const INSPECT_INIT = [TOOL, "image", "inspect", APPLE_CONTAINER_INIT_IMAGE.reference];
const MAC = { platform: "darwin", arch: "arm64", totalMemory: 24 * GiB, cpuCount: 14 } as const;
/** What the tool's inspect of an image gives, in the shape of its source at 1.6.1 (ImageResource): only the exit code is read here. */
const INIT_PRESENT = {
  exitCode: 0,
  stdout: JSON.stringify([
    {
      id: "526b1bf414a186ce6047e600830fb2981509f041cf4d4ce91653d97bd30d4700",
      configuration: {
        name: APPLE_CONTAINER_INIT_IMAGE.reference,
        descriptor: { mediaType: "application/vnd.oci.image.index.v1+json", digest: "sha256:526b1bf414a186ce6047e600830fb2981509f041cf4d4ce91653d97bd30d4700", size: 306 },
      },
      variants: [{ digest: APPLE_CONTAINER_INIT_IMAGE.digest, size: APPLE_CONTAINER_INIT_IMAGE.size }],
    },
  ]),
  stderr: "",
};

const harnesses: Harness[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.stop();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** The data folder of the Mac: a downloaded installer from the first test, and whatever the harness keeps there. */
function macDataFolder(): string {
  const folder = mkdtempSync(join(os.tmpdir(), "aidm-ui-mac-state-"));
  folders.push(folder);
  mkdirSync(join(folder, "downloads"), { recursive: true });
  writeFileSync(join(folder, "downloads", "container-1.6.1-installer-signed.pkg"), "the installer from the first test");
  return folder;
}

/** Any network request from the Mac setup is a failure of the test: everything it could download is already there. */
const noNetwork: { calls: string[]; fetch: typeof fetch } = {
  calls: [],
  fetch: Object.assign(
    async (input: Request | URL | string) => {
      noNetwork.calls.push(String(input instanceof Request ? input.url : input));
      throw new Error("The Mac setup must not download anything here.");
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch,
};

function theMac(service: "stopped" | "running", dataFolder: string) {
  const apple = new FakeRuntime({
    id: "apple-container",
    detection:
      service === "running"
        ? { version: "1.6.1" }
        : { available: false, version: "1.6.1", problem: { code: "runtime.apple_not_started", data: {} } },
  });
  const runner = new ScriptedRunner([
    {
      argv: START,
      result: () => {
        apple.detection = { ...apple.detection, available: true, problem: null };
        return recorded("apple-container", "system-start");
      },
    },
    { argv: INSPECT_INIT, result: INIT_PRESENT },
  ]);
  noNetwork.calls.length = 0;
  const h = openHarness({
    enginePollMs: 50,
    localMachine: MAC,
    runtimes: { "apple-container": apple },
    machine: recordedMachine(macInputs("26")),
    dataFolder,
    macSetup: { runner, kernelPresent: () => true, fetch: noNetwork.fetch, backoffMs: () => 0 },
  });
  harnesses.push(h);
  return { h, apple, runner };
}

const localView = async (h: Harness) => (await (await fetch(`${h.base}/api/local-engine`)).json()) as LocalEngineView;
const install = (h: Harness) => fetch(`${h.base}/api/local-engine/install`, { method: "POST" });

/** Nothing that installs, stops, removes or resets Apple's tool, its kernel or its images was run. */
function expectToolLeftAlone(runner: ScriptedRunner): void {
  const commands = runner.calls.map((argv) => argv.join(" "));
  for (const forbidden of ["open ", "--enable-kernel-install", "system kernel", "system stop", "uninstall", "image delete", "image rm", "image pull", "image prune", "--force"]) {
    expect(commands.filter((command) => command.includes(forbidden))).toEqual([]);
  }
}

for (const service of ["stopped", "running"] as const) {
  test(`with the tool and its kernel in place and the service ${service}, the install goes straight to the engine`, async () => {
    const dataFolder = macDataFolder();
    const { h, apple, runner } = theMac(service, dataFolder);

    // Before the click: no installer, no approval and no kernel among the steps.
    await eventually(async () => (await localView(h)).runtime.available.length > 0 || service === "stopped");
    const before = await localView(h);
    const planned = (before.plan ?? []).map((step) => step.id);
    expect(planned).not.toContain("installer");
    expect(planned).not.toContain("approve");
    expect(planned).not.toContain("kernel");
    if (service === "running") expect(before.plan).toBeNull();

    expect((await install(h)).status).toBe(202);
    await eventually(async () => (await localView(h)).state === "ready", 5000);

    // The service was started once without the kernel option when it was stopped, and not at all when it ran.
    const starts = runner.calls.filter((argv) => argv.join(" ").startsWith(`${TOOL} system start`));
    expect(starts).toEqual(service === "stopped" ? [START] : []);
    expectToolLeftAlone(runner);
    expect(noNetwork.calls).toEqual([]);
    // The engine came through the image downloader and the tool's load.
    expect(h.images.downloads.map((pinned) => pinned.digest)).toEqual(["sha256:107b6ef1049699b3bdcc055b4ecc704eaf0a9380202294a944e9eeff6c44e7fd"]);
    expect(apple.loads).toHaveLength(1);
    // The installer from the first test is where it was, and was not opened.
    expect(readFileSync(join(dataFolder, "downloads", "container-1.6.1-installer-signed.pkg"), "utf8")).toBe("the installer from the first test");
  });
}

test("an engine install left failed in that data folder is retried from the interface after aidm-ui starts again", async () => {
  const dataFolder = macDataFolder();
  const first = theMac("stopped", dataFolder);
  first.h.images.failNext({ code: "download.stalled", data: { seconds: 300 } });
  expect((await install(first.h)).status).toBe(202);
  await eventually(async () => (await localView(first.h)).state === "failed", 5000);
  expect((await localView(first.h)).problem).toMatchObject({ code: "install.pull_failed" });
  await first.h.stop({ leaveEngines: true });
  harnesses.splice(harnesses.indexOf(first.h), 1);

  // The next start opens the same database, the migrations find it up to date, and the install can be clicked again.
  const second = theMac("stopped", dataFolder);
  const view = await localView(second.h);
  expect(view.installed).toBeNull();
  expect(view.problem).toBeNull();
  expect((await install(second.h)).status).toBe(202);
  await eventually(async () => (await localView(second.h)).state === "ready", 5000);
  expectToolLeftAlone(second.runner);
  await second.h.stop({ leaveEngines: true });
  harnesses.splice(harnesses.indexOf(second.h), 1);
  // The database in that folder is at the newest migration, and opening it again changes nothing.
  const db = openDatabase(dataFolder);
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  expect(version).toBe(Math.max(...migrations.map((migration) => migration.version)));
  expect(applyMigrations(db, migrations)).toEqual([]);
  db.close();
});

test("after a reboot the installed engine starts again: the service is started without the kernel option, then the engine", async () => {
  const dataFolder = macDataFolder();
  const first = theMac("running", dataFolder);
  expect((await install(first.h)).status).toBe(202);
  await eventually(async () => (await localView(first.h)).state === "ready", 5000);
  const pinned = "ghcr.io/aidronemap/aidm-api@sha256:107b6ef1049699b3bdcc055b4ecc704eaf0a9380202294a944e9eeff6c44e7fd";
  await first.h.stop();
  harnesses.splice(harnesses.indexOf(first.h), 1);

  // The Mac rebooted: the service is stopped, and the engine image is still in the tool.
  const second = theMac("stopped", dataFolder);
  second.apple.holdImage(pinned);
  await eventually(async () => (await localView(second.h)).state === "ready", 5000);
  expect(second.runner.calls.filter((argv) => argv.join(" ").startsWith(`${TOOL} system start`))).toEqual([START]);
  expectToolLeftAlone(second.runner);
  expect(second.h.images.downloads).toEqual([]);
  expect(second.apple.starts.at(-1)?.spec.image).toBe(pinned);
});
