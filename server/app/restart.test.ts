import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingsView } from "../../shared/api-types.ts";
import { assetsFromFolder } from "../http/static-assets.ts";
import { eventually, freePort, lanAddress } from "../testing/harness.ts";
import { startAidmUi, type StartResult } from "./start.ts";

// An address of this computer that is not loopback; the tests that need one are skipped without it.
const address = lanAddress() as string;
let root: string;
const running: Array<{ stop(): Promise<void> }> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aidm-ui-restart-"));
});

afterEach(async () => {
  for (const copy of running.splice(0).reverse()) await copy.stop();
  await rm(root, { recursive: true, force: true });
});

async function start(argv: string[]): Promise<Extract<StartResult, { kind: "started" }>> {
  const result = await startAidmUi({
    argv: [...argv, "--data-dir", join(root, "data")],
    env: {},
    platform: process.platform,
    homeDir: root,
    cwd: root,
    assets: await assetsFromFolder(join(root, "no-interface")),
    version: "1.2.3",
    openBrowser: async () => {},
    log: () => {},
  });
  if (result.kind !== "started") throw new Error(`expected started, got ${JSON.stringify(result)}`);
  running.push(result);
  return result;
}

async function stop(result: { stop(): Promise<void> }): Promise<void> {
  await result.stop();
  running.splice(running.indexOf(result), 1);
}

function put(port: number, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { method: "PUT", body: JSON.stringify(body) });
}

async function settingsOf(port: number): Promise<SettingsView> {
  return (await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json()) as SettingsView;
}

async function refusesConnections(port: number): Promise<boolean> {
  try {
    await fetch(`http://${address}:${port}/api/settings`, { signal: AbortSignal.timeout(1000) });
    return false;
  } catch {
    return true;
  }
}

test("a port set through the interface is used after a restart", async () => {
  const firstPort = await freePort();
  const chosen = await freePort();
  const first = await start(["--port", String(firstPort)]);

  const response = await put(first.port, "/api/settings/port", { port: chosen });
  expect(response.status).toBe(200);
  await stop(first);

  const second = await start([]);
  expect(second.port).toBe(chosen);
  const view = await settingsOf(second.port);
  expect(view.port).toBe(chosen);
  expect(view.listeningPort).toBe(chosen);
});

test("the command line port wins over the stored one", async () => {
  const firstPort = await freePort();
  const chosen = await freePort();
  const first = await start(["--port", String(firstPort)]);
  await put(first.port, "/api/settings/port", { port: chosen });
  await stop(first);

  const second = await start(["--port", String(firstPort)]);
  expect(second.port).toBe(firstPort);
  expect((await settingsOf(second.port)).port).toBe(chosen);
});

test.skipIf(address === undefined)("a stored LAN switch is kept after a restart and the passphrase still works", async () => {
  const port = await freePort();
  const first = await start(["--port", String(port)]);
  await put(first.port, "/api/settings/lan", { enabled: true, passphrase: "field tablet passphrase" });
  await stop(first);

  const second = await start(["--port", String(port)]);
  const remote = `http://${address}:${second.port}`;
  expect((await fetch(`${remote}/api/settings`)).status).toBe(401);
  const login = await fetch(`${remote}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ passphrase: "field tablet passphrase" }),
  });
  expect(login.status).toBe(204);
});

test.skipIf(address === undefined)("the LAN switch off listens on loopback only", async () => {
  const result = await start(["--port", String(await freePort())]);
  expect(await refusesConnections(result.port)).toBe(true);
  expect((await fetch(`http://127.0.0.1:${result.port}/api/health`)).status).toBe(200);
});

test.skipIf(address === undefined)("the LAN switch moves the running server to the network and back", async () => {
  const port = await freePort();
  const result = await start(["--port", String(port)]);
  expect(await refusesConnections(port)).toBe(true);

  const on = await put(port, "/api/settings/lan", { enabled: true, passphrase: "field tablet passphrase" });
  expect(on.status).toBe(200);
  await eventually(async () => !(await refusesConnections(port)));
  const remote = await fetch(`http://${address}:${port}/api/settings`);
  expect(remote.status).toBe(401);
  expect(await remote.json()).toEqual({ error: { code: "auth.passphrase_required", data: {} } });
  // The operator's own computer is still served on the same port.
  expect((await fetch(`http://127.0.0.1:${port}/api/settings`)).status).toBe(200);

  const off = await put(port, "/api/settings/lan", { enabled: false });
  expect(off.status).toBe(200);
  await eventually(() => refusesConnections(port));
  expect((await settingsOf(port)).lan.enabled).toBe(false);
  expect(result.port).toBe(port);
});

test("the database file is created in the data folder and closed when the server stops", async () => {
  const result = await start(["--port", String(await freePort())]);
  expect(await Bun.file(join(result.dataFolder, "aidm-ui.sqlite")).exists()).toBe(true);
  await stop(result);
  // A second start on the same folder works, so nothing kept the file locked.
  const again = await start(["--port", String(await freePort())]);
  expect((await settingsOf(again.port)).listeningPort).toBe(again.port);
});
