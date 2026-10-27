import { expect, test } from "bun:test";
import type { ApiError } from "../../shared/api-error.ts";
import { checkEngineAddress, plainHttpWarning } from "./address-rule.ts";

const noDns = async (): Promise<string[]> => {
  throw new Error("The address rule must not look this name up.");
};
const WARNING: ApiError = { code: "engine.plain_http_local", data: {} };

async function accepts(address: string, resolve = noDns) {
  const check = await checkEngineAddress(address, resolve);
  if (!check.ok) throw new Error(`${address} was refused with ${check.error.code}`);
  return check;
}

async function refusedWith(address: string, resolve = noDns): Promise<string> {
  const check = await checkEngineAddress(address, resolve);
  if (check.ok) throw new Error(`${address} was accepted`);
  return check.error.code;
}

test("plain http is accepted without a warning on loopback, whose traffic never leaves the computer", async () => {
  for (const address of ["http://127.0.0.1:3000", "http://127.255.255.254:3000", "http://localhost:3000", "http://LOCALHOST:3000", "http://[::1]:3000"]) {
    expect((await accepts(address)).warning, address).toBeNull();
    expect(plainHttpWarning(address), address).toBeNull();
  }
});

test("plain http is accepted, with a warning, on private and link-local addresses", async () => {
  for (const address of [
    "http://10.0.0.1:3000",
    "http://10.255.255.255:3000",
    "http://172.16.0.0:3000",
    "http://172.31.255.255:3000",
    "http://192.168.1.5:3000",
    "http://169.254.10.20:3000",
    "http://[fc00::1]:3000",
    "http://[fd12:3456::1]:3000",
    "http://[fe80::1]:3000",
    "http://[febf::1]:3000",
    "http://[::ffff:192.168.1.5]:3000",
  ]) {
    expect((await accepts(address)).warning, address).toEqual(WARNING);
    expect(plainHttpWarning(address), address).toEqual(WARNING);
  }
  expect(plainHttpWarning("https://192.168.1.5:3000")).toBeNull();
});

test("plain http to a public address needs https", async () => {
  for (const address of [
    "http://8.8.8.8:3000",
    "http://172.15.255.255:3000",
    "http://172.32.0.0:3000",
    "http://11.0.0.1:3000",
    "http://192.169.0.1:3000",
    "http://169.253.255.255:3000",
    "http://128.0.0.1:3000",
    "http://0.0.0.0:3000",
    "http://[2001:4860:4860::8888]:3000",
    "http://[fec0::1]:3000",
    "http://[fbff::1]:3000",
    "http://[::ffff:8.8.8.8]:3000",
    "http://[::]:3000",
  ]) {
    expect(await refusedWith(address), address).toBe("engine.https_required");
  }
});

test("a host name is resolved and every address it has must be local", async () => {
  expect((await accepts("http://nas.lan:3000", async () => ["192.168.1.9"])).warning).toEqual(WARNING);
  expect(await refusedWith("http://engine.example", async () => ["93.184.216.34"])).toBe("engine.https_required");
  expect(await refusedWith("http://engine.example", async () => ["192.168.1.9", "93.184.216.34"])).toBe(
    "engine.https_required",
  );
});

test("a host name that does not resolve is unreachable", async () => {
  expect(
    await refusedWith("http://nowhere.example", async () => {
      throw new Error("ENOTFOUND");
    }),
  ).toBe("engine.unreachable");
  expect(await refusedWith("http://nowhere.example", async () => [])).toBe("engine.unreachable");
});

test("https is accepted without a warning and without a look-up", async () => {
  const check = await accepts("https://engine.example/aidm");
  expect(check).toEqual({ ok: true, address: "https://engine.example/aidm", warning: null });
  expect((await accepts("https://8.8.8.8:3000")).warning).toBeNull();
});

test("the address is written in one form: trimmed, no trailing slash, host in lower case", async () => {
  expect((await accepts("  http://192.168.1.5:3000/  ")).address).toBe("http://192.168.1.5:3000");
  expect((await accepts("https://Engine.Example/aidm/")).address).toBe("https://engine.example/aidm");
  expect((await accepts("https://engine.example")).address).toBe("https://engine.example");
  expect((await accepts("http://[::1]:3000/")).address).toBe("http://[::1]:3000");
});

test("anything that is not a plain http or https address is invalid", async () => {
  for (const address of [
    "",
    "   ",
    "engine.example",
    "192.168.1.5:3000",
    "ftp://192.168.1.5",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://",
    "http://user@192.168.1.5:3000",
    "http://user:pass@192.168.1.5:3000",
    "http://192.168.1.5:3000/?token=abc",
    "http://192.168.1.5:3000/#top",
    "http://192.168.1.5:3000?",
    "http://192.168.1.5:99999",
  ]) {
    expect(await refusedWith(address), address).toBe("engine.address_invalid");
  }
});
