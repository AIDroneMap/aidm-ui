import { afterEach, expect, test } from "bun:test";
import { openHarness, lanAddress, lanTest, type Harness } from "../testing/harness.ts";
import { SESSION_COOKIE } from "./sessions.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const PASSPHRASE = "tablet-on-the-field";
const lan = lanAddress();

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function switchLanOn(h: Harness): Promise<void> {
  const response = await fetch(`${h.base}/api/settings/lan`, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, passphrase: PASSPHRASE }),
  });
  expect(response.status).toBe(200);
}

/** The cookie a login set, as the browser would send it back. */
async function signIn(url: string, passphrase = PASSPHRASE): Promise<string> {
  const response = await fetch(`${url}/api/auth/login`, json({ passphrase }));
  expect(response.status).toBe(204);
  const cookie = response.headers.get("set-cookie") ?? "";
  return cookie.split(";")[0] ?? "";
}

lanTest("with the LAN switch off, a request from another address is refused with a code", async () => {
  harness = openHarness({ hostname: "0.0.0.0" });
  const response = await fetch(`http://${lan}:${harness.port}/api/settings`);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { code: "auth.lan_disabled", data: {} } });

  const page = await fetch(`http://${lan}:${harness.port}/`);
  expect(page.status).toBe(403);

  const own = await fetch(`${harness.base}/api/settings`);
  expect(own.status).toBe(200);
});

lanTest("with the LAN switch on, another address needs the passphrase", async () => {
  harness = openHarness({ hostname: "0.0.0.0" });
  await switchLanOn(harness);
  const remote = `http://${lan}:${harness.port}`;

  const refused = await fetch(`${remote}/api/settings`);
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual({ error: { code: "auth.passphrase_required", data: {} } });

  // The interface and the few routes it needs to ask for the passphrase stay open.
  expect((await fetch(`${remote}/some/page`)).status).not.toBe(401);
  expect((await fetch(`${remote}/api/health`)).status).toBe(200);
  expect(await (await fetch(`${remote}/api/auth/session`)).json()).toEqual({ passphraseRequired: true });

  const wrong = await fetch(`${remote}/api/auth/login`, json({ passphrase: "not the passphrase" }));
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toEqual({ error: { code: "auth.passphrase_wrong", data: {} } });

  const login = await fetch(`${remote}/api/auth/login`, json({ passphrase: PASSPHRASE }));
  expect(login.status).toBe(204);
  const setCookie = login.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain(`${SESSION_COOKIE}=`);
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");

  const cookie = setCookie.split(";")[0] ?? "";
  const served = await fetch(`${remote}/api/settings`, { headers: { cookie } });
  expect(served.status).toBe(200);
  expect(await (await fetch(`${remote}/api/auth/session`, { headers: { cookie } })).json()).toEqual({
    passphraseRequired: false,
  });

  const forged = await fetch(`${remote}/api/settings`, { headers: { cookie: `${SESSION_COOKIE}=forged` } });
  expect(forged.status).toBe(401);
});

test("the operator's own computer needs no login even with the LAN switch on", async () => {
  harness = openHarness();
  await switchLanOn(harness);
  expect((await fetch(`${harness.base}/api/settings`)).status).toBe(200);
  expect(await (await fetch(`${harness.base}/api/auth/session`)).json()).toEqual({ passphraseRequired: false });
});

lanTest("turning the LAN switch off or changing the passphrase ends every session", async () => {
  harness = openHarness({ hostname: "0.0.0.0" });
  await switchLanOn(harness);
  const remote = `http://${lan}:${harness.port}`;
  const cookie = await signIn(remote);

  await fetch(`${harness.base}/api/settings/lan`, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, passphrase: "a different passphrase" }),
  });
  expect((await fetch(`${remote}/api/settings`, { headers: { cookie } })).status).toBe(401);

  const second = await signIn(remote, "a different passphrase");
  expect((await fetch(`${remote}/api/settings`, { headers: { cookie: second } })).status).toBe(200);

  await fetch(`${harness.base}/api/settings/lan`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  const afterOff = await fetch(`${remote}/api/settings`, { headers: { cookie: second } });
  expect(afterOff.status).toBe(403);
  expect(await afterOff.json()).toEqual({ error: { code: "auth.lan_disabled", data: {} } });
});

test("a login with the LAN switch off is refused", async () => {
  harness = openHarness();
  const response = await fetch(`${harness.base}/api/auth/login`, json({ passphrase: PASSPHRASE }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { code: "auth.lan_disabled", data: {} } });
});

test("a request to loopback under a foreign host name is refused", async () => {
  harness = openHarness();
  const response = await fetch(`${harness.base}/api/settings`, { headers: { host: "evil.example:8823" } });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { code: "auth.host_not_allowed", data: {} } });

  for (const host of [`localhost:${harness.port}`, `127.0.0.1:${harness.port}`, "localhost", `[::1]:${harness.port}`]) {
    const allowed = await fetch(`${harness.base}/api/health`, { headers: { host } });
    expect(allowed.status).toBe(200);
  }
});

test("a write from another web site is refused, a write with no origin is served", async () => {
  harness = openHarness();
  const url = `${harness.base}/api/settings/port`;
  const body = JSON.stringify({ port: 9100 });

  const foreign = await fetch(url, { method: "PUT", body, headers: { origin: "http://evil.example" } });
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toEqual({ error: { code: "auth.origin_not_allowed", data: {} } });
  expect(harness.settings.get("server.port")).toBeNull();

  const own = await fetch(url, { method: "PUT", body, headers: { origin: `http://127.0.0.1:${harness.port}` } });
  expect(own.status).toBe(200);

  const none = await fetch(url, { method: "PUT", body: JSON.stringify({ port: null }) });
  expect(none.status).toBe(200);
  expect(harness.settings.get("server.port")).toBeNull();
});

test("reading is allowed whatever the origin", async () => {
  harness = openHarness();
  const response = await fetch(`${harness.base}/api/settings`, { headers: { origin: "http://evil.example" } });
  expect(response.status).toBe(200);
});

lanTest("another address cannot write from a foreign origin even with a session", async () => {
  harness = openHarness({ hostname: "0.0.0.0" });
  await switchLanOn(harness);
  const remote = `http://${lan}:${harness.port}`;
  const cookie = await signIn(remote);
  const response = await fetch(`${remote}/api/settings/port`, {
    method: "PUT",
    body: JSON.stringify({ port: 9100 }),
    headers: { cookie, origin: "http://evil.example" },
  });
  expect(response.status).toBe(403);
});

test("five wrong logins block the address until ten minutes have passed", async () => {
  harness = openHarness();
  await switchLanOn(harness);
  const login = (passphrase: string) => fetch(`${harness!.base}/api/auth/login`, json({ passphrase }));

  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await login("wrong guess")).status).toBe(401);
  }
  const blocked = await login(PASSPHRASE);
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toEqual({ error: { code: "auth.too_many_attempts", data: {} } });

  harness.clock.now += 9 * 60 * 1000;
  expect((await login(PASSPHRASE)).status).toBe(429);

  harness.clock.now += 61 * 1000;
  expect((await login(PASSPHRASE)).status).toBe(204);
});

test("a right login clears the failures before it", async () => {
  harness = openHarness();
  await switchLanOn(harness);
  const login = (passphrase: string) => fetch(`${harness!.base}/api/auth/login`, json({ passphrase }));
  for (let attempt = 0; attempt < 4; attempt++) await login("wrong guess");
  expect((await login(PASSPHRASE)).status).toBe(204);
  for (let attempt = 0; attempt < 4; attempt++) {
    expect((await login("wrong guess")).status).toBe(401);
  }
});

lanTest("odd spellings of an API path do not get past the passphrase", async () => {
  harness = openHarness({ hostname: "0.0.0.0" });
  await switchLanOn(harness);
  harness.settings.set("server.port", 9321);
  const remote = `http://${lan}:${harness.port}`;
  for (const path of ["/api/settings/", "/API/settings", "/%61pi/settings", "//api/settings", "/api/./settings"]) {
    const response = await fetch(`${remote}${path}`);
    const text = await response.text();
    expect(text).not.toContain("9321");
  }
});

test("ten wrong logins fired at once cannot all be tried: five are judged, the rest are turned away", async () => {
  harness = openHarness();
  await switchLanOn(harness);
  const login = (passphrase: string) => fetch(`${harness!.base}/api/auth/login`, json({ passphrase }));

  const answers = await Promise.all(Array.from({ length: 10 }, () => login("wrong guess")));
  const codes = await Promise.all(answers.map(async (answer) => ((await answer.json()) as { error: { code: string } }).error.code));
  expect(codes.filter((code) => code === "auth.passphrase_wrong").length).toBeLessThanOrEqual(5);
  expect(codes.filter((code) => code === "auth.too_many_attempts").length).toBeGreaterThanOrEqual(5);
  expect(answers.map((answer) => answer.status).every((status) => status === 401 || status === 429)).toBe(true);

  expect((await login(PASSPHRASE)).status).toBe(429);
});

test("a passphrase longer than 1024 characters is refused before it is hashed", async () => {
  harness = openHarness();
  await switchLanOn(harness);
  const response = await fetch(`${harness.base}/api/auth/login`, json({ passphrase: "x".repeat(1025) }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "api.invalid_body", data: {} } });

  const longest = await fetch(`${harness.base}/api/auth/login`, json({ passphrase: "x".repeat(1024) }));
  expect(longest.status).toBe(401);
});

lanTest("only the operator's own computer can change the LAN switch, even with a session", async () => {
  harness = openHarness({ hostname: "0.0.0.0" });
  await switchLanOn(harness);
  const remote = `http://${lan}:${harness.port}`;
  const cookie = await signIn(remote);

  for (const body of [{ enabled: false }, { enabled: true, passphrase: "another long passphrase" }]) {
    const response = await fetch(`${remote}/api/settings/lan`, { method: "PUT", body: JSON.stringify(body), headers: { cookie } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "settings.lan_local_only", data: {} } });
  }
  expect(harness.settings.get("lan.enabled")).toBe(true);
  expect((await fetch(`${remote}/api/settings`, { headers: { cookie } })).status).toBe(200);
});

lanTest("a computer on the network without a session may only read the interface and ask to sign in", async () => {
  harness = openHarness({ hostname: "0.0.0.0" });
  await switchLanOn(harness);
  const remote = `http://${lan}:${harness.port}`;

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${remote}/some/page`, { method, body: "{}" });
    expect(response.status, method).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "auth.passphrase_required", data: {} } });
  }
  expect((await fetch(`${remote}/some/page`)).status).not.toBe(401);
  expect((await fetch(`${remote}/api/health`, { method: "POST", body: "{}" })).status).toBe(401);
});
