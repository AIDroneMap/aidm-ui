import { afterEach, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { PASSPHRASE_MIN_LENGTH, type SettingsView } from "../../shared/api-types.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function put(h: Harness, path: string, body: unknown): Promise<Response> {
  return fetch(`${h.base}${path}`, { method: "PUT", body: JSON.stringify(body) });
}

test("settings show the stored port, the port in use and the local network addresses", async () => {
  harness = openHarness();
  const view = (await (await fetch(`${harness.base}/api/settings`)).json()) as SettingsView;
  expect(view.port).toBeNull();
  expect(view.listeningPort).toBe(harness.port);
  expect(view.lan.enabled).toBe(false);

  const expected = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  expect(view.lan.addresses).toEqual(expected);
});

test("a valid port is stored and shown; null goes back to the default", async () => {
  harness = openHarness();
  const stored = (await (await put(harness, "/api/settings/port", { port: 9100 })).json()) as SettingsView;
  expect(stored.port).toBe(9100);
  expect(harness.settings.get("server.port")).toBe(9100);

  const cleared = await put(harness, "/api/settings/port", { port: null });
  expect(cleared.status).toBe(200);
  expect(((await cleared.json()) as SettingsView).port).toBeNull();
});

test("a port outside 1 to 65535 or not a whole number is refused with the limits", async () => {
  harness = openHarness();
  for (const port of [0, 70000, 1.5, "8823", -1, true, []]) {
    const response = await put(harness, "/api/settings/port", { port });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "settings.port_invalid", data: { min: 1, max: 65535 } },
    });
  }
  expect(harness.settings.get("server.port")).toBeNull();
  expect((await put(harness, "/api/settings/port", { port: 1 })).status).toBe(200);
  expect((await put(harness, "/api/settings/port", { port: 65535 })).status).toBe(200);
});

test("a port request without a port is an invalid body", async () => {
  harness = openHarness();
  const response = await put(harness, "/api/settings/port", {});
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "api.invalid_body" } });
});

test("the LAN switch needs a passphrase of the minimum length", async () => {
  harness = openHarness();
  const response = await put(harness, "/api/settings/lan", { enabled: true, passphrase: "short" });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { code: "settings.passphrase_too_short", data: { min: PASSPHRASE_MIN_LENGTH } },
  });
  expect(harness.settings.get("lan.enabled")).toBe(false);

  const missing = await put(harness, "/api/settings/lan", { enabled: true });
  expect(missing.status).toBe(400);
  expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("api.invalid_body");
});

test("turning the LAN switch on stores a hash and moves the listener to every interface after answering", async () => {
  harness = openHarness();
  const response = await put(harness, "/api/settings/lan", { enabled: true, passphrase: "long enough passphrase" });
  expect(response.status).toBe(200);
  expect(((await response.json()) as SettingsView).lan.enabled).toBe(true);

  const hash = harness.settings.get("lan.passphraseHash");
  expect(hash).toStartWith("$argon2id$");
  expect(hash).not.toContain("long enough passphrase");
  await eventually(async () => harness!.rebinds.length === 1);
  expect(harness.rebinds).toEqual(["0.0.0.0"]);
});

test("turning the LAN switch off removes the hash and moves the listener back to loopback", async () => {
  harness = openHarness();
  await put(harness, "/api/settings/lan", { enabled: true, passphrase: "long enough passphrase" });
  const response = await put(harness, "/api/settings/lan", { enabled: false });
  expect(((await response.json()) as SettingsView).lan.enabled).toBe(false);
  expect(harness.settings.get("lan.passphraseHash")).toBeNull();
  expect(harness.settings.get("lan.enabled")).toBe(false);
  await eventually(async () => harness!.rebinds.length === 2);
  expect(harness.rebinds).toEqual(["0.0.0.0", "127.0.0.1"]);
});

test("the passphrase hash is in no response", async () => {
  harness = openHarness();
  const passphrase = "long enough passphrase";
  const bodies: string[] = [];
  const read = async (response: Response) => {
    bodies.push(await response.text());
  };
  await read(await put(harness, "/api/settings/lan", { enabled: true, passphrase }));
  await read(await fetch(`${harness.base}/api/settings`));
  await read(await fetch(`${harness.base}/api/auth/session`));
  await read(await fetch(`${harness.base}/api/health`));

  const hash = harness.settings.get("lan.passphraseHash") as string;
  for (const body of bodies) {
    expect(body).not.toContain(hash);
    expect(body).not.toContain("argon2");
    expect(body).not.toContain(passphrase);
  }
});
