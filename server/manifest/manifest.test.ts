import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { PackagesView, RefreshResult } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { linuxInputs, recordedMachine } from "../../test-support/recorded-machine.ts";
import {
  generateSigner,
  manifestBytes,
  sampleManifest,
  signedRelease,
  type TestSigner,
} from "../../test-support/signed-manifest.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";
import { ACCEPTED_KEYS } from "./keys.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LATEST = "/releases/latest/download/manifest.json";

let fake: FakeFileServer;
let signer: TestSigner;
let harness: Harness | undefined;
let folder: string | undefined;

beforeEach(async () => {
  fake = new FakeFileServer();
  await fake.start();
  signer = await generateSigner();
});

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  await fake.stop();
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

/** The test key and the real list, because the built-in entry is signed by the real list's key. */
function keys(...signers: TestSigner[]) {
  return [...signers.map((s) => s.key), ...ACCEPTED_KEYS];
}

function open(options: Parameters<typeof openHarness>[0] = {}): Harness {
  harness = openHarness({
    ...options,
    manifest: { releasesUrl: fake.url("/releases"), keys: keys(signer), fetch: (url, init) => fetch(url, init), ...options.manifest },
  });
  return harness;
}

async function publish(tag: string, manifest: unknown, by: TestSigner = signer): Promise<void> {
  const { bytes, signature } = await signedRelease(by, manifest);
  publishBytes(tag, bytes, signature);
}

function publishBytes(tag: string, bytes: Uint8Array, signature: Uint8Array): void {
  fake.files.set(`/releases/download/${tag}/manifest.json`, bytes);
  fake.files.set(`/releases/download/${tag}/manifest.json.sig`, signature);
  fake.redirects.set(LATEST, `/releases/download/${tag}/manifest.json`);
}

async function packages(h: Harness): Promise<PackagesView> {
  const response = await fetch(`${h.base}/api/packages`);
  expect(response.status).toBe(200);
  return (await response.json()) as PackagesView;
}

async function refresh(h: Harness): Promise<{ result: RefreshResult; view: PackagesView }> {
  const response = await fetch(`${h.base}/api/packages/refresh`, { method: "POST" });
  expect(response.status).toBe(200);
  return (await response.json()) as { result: RefreshResult; view: PackagesView };
}

function latestRequests(): number {
  return fake.requests.filter((request) => request.path === LATEST).length;
}

function put(h: Harness, path: string, body: unknown): Promise<Response> {
  return fetch(`${h.base}${path}`, { method: "PUT", body: JSON.stringify(body) });
}

// With no network, the wizard offers the built-in 2.5.0 package for the detected variant.

test("with no network, a Linux x64 computer is offered the built-in 2.5.0 amd64 image", async () => {
  const calls: string[] = [];
  const h = open({
    manifest: {
      fetch: async (url) => {
        calls.push(url);
        throw new Error("no network");
      },
    },
  });
  expect(await packages(h)).toEqual({
    offer: {
      packageVersion: "2.5.0",
      engineVersion: "0.1.0",
      variant: "linux-amd64-cpu",
      kind: "container",
      size: 682533845,
      processorSize: null,
      source: "builtin",
      tag: null,
    },
    gpu: { state: "not_used", reason: null, guideUrl: null },
    reason: null,
    updateCheck: null,
    lastCheck: null,
  });
  expect(calls).toEqual([]);
  expect(fake.requests).toEqual([]);
});

test("a Linux arm64 computer is offered the built-in arm64 image", async () => {
  const h = open({ machine: recordedMachine(linuxInputs({ arch: "arm64" })) });
  const view = await packages(h);
  expect(view.offer?.variant).toBe("linux-arm64-cpu");
  expect(view.offer?.size).toBe(622710197);
  expect(fake.requests).toEqual([]);
});

test("a Mac with Apple silicon is offered the arm64 image for the container tool", async () => {
  const h = open({ machine: recordedMachine(linuxInputs({ platform: "darwin", arch: "arm64" })) });
  const view = await packages(h);
  expect(view.offer?.variant).toBe("linux-arm64-cpu");
  expect(view.offer?.kind).toBe("container");
});

test("a Mac with Apple silicon is offered the native package once a manifest has one", async () => {
  const native = { kind: "native", url: "https://example.org/mac.zip", size: 9, sha256: "cd".repeat(32), gpu: false } as const;
  const manifest = sampleManifest();
  manifest.variants["darwin-arm64"] = native;
  await publish("v2.6.0", manifest);
  const h = open({ machine: recordedMachine(linuxInputs({ platform: "darwin", arch: "arm64" })) });
  await refresh(h);
  expect((await packages(h)).offer).toMatchObject({ variant: "darwin-arm64", kind: "native", size: 9 });
});

test("a Linux computer is offered the native package, not an image, when the manifest has one for it", async () => {
  const manifest = sampleManifest();
  manifest.variants["linux-amd64-cpu"] = { kind: "native", url: "https://example.org/linux.tar.gz", size: 7, sha256: "cd".repeat(32), gpu: false };
  await publish("v2.6.0", manifest);
  const h = open();
  await refresh(h);
  expect((await packages(h)).offer).toMatchObject({ variant: "linux-amd64-cpu", kind: "native", size: 7 });
});

test("a Windows computer is offered nothing yet, with the reason, and nothing is requested", async () => {
  const h = open({ machine: recordedMachine(linuxInputs({ platform: "win32", arch: "x64" })) });
  const view = await packages(h);
  expect(view.offer).toBeNull();
  expect(view.reason).toEqual({ code: "machine.windows_not_yet", data: {} });
  expect(fake.requests).toEqual([]);
});

test("a computer of another kind gets no offer", async () => {
  const h = open({ machine: recordedMachine(linuxInputs({ platform: "freebsd", arch: "x64" })) });
  const view = await packages(h);
  expect(view.reason).toEqual({ code: "manifest.no_variant", data: { platform: "freebsd", arch: "x64" } });
});

test("a Windows computer is still offered nothing when a manifest has a Windows package", async () => {
  await publish("v2.6.0", sampleManifest());
  const h = open({ machine: recordedMachine(linuxInputs({ platform: "win32", arch: "x64" })) });
  await refresh(h);
  const view = await packages(h);
  expect(view.offer).toBeNull();
  expect(view.reason?.code).toBe("machine.windows_not_yet");
});

test("the GPU image is not the offer while the graphics card checks have not passed", async () => {
  const view = await packages(open());
  expect(view.offer?.variant).not.toBe("linux-amd64-gpu");
});

// A manifest signed with an unknown key, or with one altered byte, is refused with a message code.

test("a manifest signed with a key that is not listed is refused", async () => {
  const stranger = await generateSigner("stranger");
  await publish("v2.6.0", sampleManifest(), stranger);
  const h = open();
  const { result, view } = await refresh(h);
  expect(result).toEqual({ ok: false, error: { code: "manifest.signature_invalid", data: {} } });
  expect(view.offer?.source).toBe("builtin");
  expect(view.lastCheck?.problem).toEqual({ code: "manifest.signature_invalid", data: {} });
});

test("a manifest with one altered byte is refused", async () => {
  const { bytes, signature } = await signedRelease(signer, sampleManifest());
  const altered = bytes.slice();
  const at = new TextDecoder().decode(bytes).indexOf('"sequence": 2') + '"sequence": '.length;
  altered[at] = "3".charCodeAt(0);
  publishBytes("v2.6.0", altered, signature);
  const h = open();
  expect((await refresh(h)).result).toEqual({ ok: false, error: { code: "manifest.signature_invalid", data: {} } });
});

test("a signed manifest that is not valid is malformed", async () => {
  await publish("v2.6.0", { ...sampleManifest(), schemaVersion: 2 });
  const h = open();
  const { result } = await refresh(h);
  expect(result).toMatchObject({ ok: false, error: { code: "manifest.malformed" } });
});

test("a missing signature file is a failed fetch", async () => {
  await publish("v2.6.0", sampleManifest());
  fake.files.delete("/releases/download/v2.6.0/manifest.json.sig");
  const h = open();
  expect((await refresh(h)).result).toEqual({
    ok: false,
    error: { code: "manifest.fetch_failed", data: { step: "signature", status: 404 } },
  });
});

test("a release with no manifest is a failed fetch", async () => {
  const h = open();
  const { result } = await refresh(h);
  expect(result).toEqual({ ok: false, error: { code: "manifest.fetch_failed", data: { step: "discover", status: 404 } } });
});

test("a manifest or signature over 1 MiB is refused", async () => {
  await publish("v2.6.0", sampleManifest());
  fake.files.set("/releases/download/v2.6.0/manifest.json", new Uint8Array(1024 * 1024 + 1));
  const h = open();
  expect((await refresh(h)).result).toMatchObject({ ok: false, error: { code: "manifest.fetch_failed" } });
});

test("a host that cannot be reached is a failed fetch", async () => {
  const h = open({ manifest: { releasesUrl: "http://127.0.0.1:1/releases" } });
  expect((await refresh(h)).result).toEqual({ ok: false, error: { code: "manifest.fetch_failed", data: { step: "discover" } } });
});

// A manifest with a lower sequence number than the held one is refused; a higher one replaces it.

test("a lower sequence is refused, an equal one changes nothing, a higher one replaces", async () => {
  const h = open();
  await publish("v2.6.0", sampleManifest({ sequence: 5, packageVersion: "2.6.0" }));
  expect((await refresh(h)).result).toEqual({ ok: true, tag: "v2.6.0", replaced: true });
  expect(await packages(h)).toMatchObject({ offer: { packageVersion: "2.6.0", source: "downloaded", tag: "v2.6.0" } });

  await publish("v2.5.9", sampleManifest({ sequence: 3, packageVersion: "2.5.9" }));
  expect((await refresh(h)).result).toEqual({
    ok: false,
    error: { code: "manifest.older_sequence", data: { held: 5, offered: 3 } },
  });
  expect((await packages(h)).offer?.packageVersion).toBe("2.6.0");

  await publish("v2.6.0-again", sampleManifest({ sequence: 5, packageVersion: "2.6.1" }));
  expect((await refresh(h)).result).toEqual({ ok: true, tag: "v2.6.0-again", replaced: false });
  expect((await packages(h)).offer?.packageVersion).toBe("2.6.0");

  await publish("v2.7.0", sampleManifest({ sequence: 7, packageVersion: "2.7.0" }));
  expect((await refresh(h)).result).toEqual({ ok: true, tag: "v2.7.0", replaced: true });
  expect(await packages(h)).toMatchObject({ offer: { packageVersion: "2.7.0", source: "downloaded", tag: "v2.7.0" } });
});

test("a manifest with the sequence of the built-in entry changes nothing", async () => {
  await publish("v2.6.0", sampleManifest({ sequence: 1 }));
  const h = open();
  expect((await refresh(h)).result).toEqual({ ok: true, tag: "v2.6.0", replaced: false });
  expect((await packages(h)).offer?.source).toBe("builtin");
});

test("a downloaded manifest survives a restart on the same data folder", async () => {
  folder = mkdtempSync(join(os.tmpdir(), "aidm-ui-manifest-"));
  await publish("v2.6.0", sampleManifest({ sequence: 4, packageVersion: "2.6.0" }));
  const first = open({ dataFolder: folder });
  await refresh(first);
  await first.stop();
  harness = undefined;

  // The second start has no network at all.
  const second = open({ dataFolder: folder, manifest: { fetch: async () => { throw new Error("no network"); } } });
  expect(await packages(second)).toMatchObject({ offer: { packageVersion: "2.6.0", source: "downloaded", tag: "v2.6.0" } });
});

test("a stored manifest whose key left the list is ignored and logged", async () => {
  folder = mkdtempSync(join(os.tmpdir(), "aidm-ui-manifest-"));
  await publish("v2.6.0", sampleManifest({ sequence: 4 }));
  const first = open({ dataFolder: folder });
  await refresh(first);
  await first.stop();
  harness = undefined;

  const second = open({ dataFolder: folder, manifest: { keys: [...ACCEPTED_KEYS] } });
  expect((await packages(second)).offer).toMatchObject({ packageVersion: "2.5.0", source: "builtin" });
  expect(second.logs.some((line) => line.includes("stored manifest was ignored"))).toBe(true);
});

test("a manifest below the highest sequence ever accepted is refused, even after the stored one was dropped", async () => {
  folder = mkdtempSync(join(os.tmpdir(), "aidm-ui-manifest-"));
  const second = await generateSigner("second-key");
  await publish("v2.6.0", sampleManifest({ sequence: 5 }));
  const first = open({ dataFolder: folder });
  await refresh(first);
  await first.stop();
  harness = undefined;

  // The key that signed the stored manifest leaves the list, so the stored manifest is dropped.
  await publish("v2.5.9", sampleManifest({ sequence: 3, packageVersion: "2.5.9" }), second);
  const next = open({ dataFolder: folder, manifest: { keys: keys(second) } });
  expect((await packages(next)).offer).toMatchObject({ packageVersion: "2.5.0", source: "builtin" });
  expect((await refresh(next)).result).toEqual({
    ok: false,
    error: { code: "manifest.older_sequence", data: { held: 5, offered: 3 } },
  });
  expect((await packages(next)).offer?.source).toBe("builtin");

  // The same sequence as the floor is accepted again, because nothing newer is held.
  await publish("v2.6.0-resigned", sampleManifest({ sequence: 5 }), second);
  expect((await refresh(next)).result).toEqual({ ok: true, tag: "v2.6.0-resigned", replaced: true });
});

test("variants this version does not know are skipped and logged once, and the rest is used", async () => {
  const manifest = {
    ...sampleManifest(),
    futureField: { anything: true },
    variants: {
      ...sampleManifest().variants,
      "linux-riscv-cpu": { kind: "container", image: "ghcr.io/aidronemap/aidm-api", digest: `sha256:${"ab".repeat(32)}`, size: 1, gpu: false },
    },
  };
  await publish("v2.6.0", manifest);
  const h = open();
  expect((await refresh(h)).result).toEqual({ ok: true, tag: "v2.6.0", replaced: true });
  expect((await packages(h)).offer).toMatchObject({ packageVersion: "2.6.0", variant: "linux-amd64-cpu", size: 111 });
  await packages(h);
  expect(h.logs.filter((line) => line.includes("linux-riscv-cpu"))).toHaveLength(1);
});

test("a stored manifest that was altered after it was signed is ignored and logged once, and the built-in offer stands", async () => {
  await publish("v2.6.0", sampleManifest({ sequence: 4 }));
  const h = open();
  await refresh(h);
  expect((await packages(h)).offer?.source).toBe("downloaded");

  const held = h.settings.get("manifest.held") as { bytes: string; signature: string; tag: string };
  const text = atob(held.bytes).replace('"packageVersion": "2.6.0"', '"packageVersion": "9.9.9"');
  h.settings.set("manifest.held", { ...held, bytes: btoa(text) });

  expect((await packages(h)).offer).toMatchObject({ packageVersion: "2.5.0", source: "builtin" });
  await packages(h);
  await packages(h);
  expect(h.logs.filter((line) => line.includes("stored manifest was ignored"))).toHaveLength(1);
});

// A manifest whose minimum aidm-ui version is too high is not offered and the "update the interface" message code is shown.

test("a newer manifest that needs a newer interface is kept, the built-in package is still offered, and the reason says why", async () => {
  await publish("v3.0.0", sampleManifest({ sequence: 9, minimumUiVersion: "10.0.0" }));
  const h = open();
  expect((await refresh(h)).result).toEqual({ ok: true, tag: "v3.0.0", replaced: true });
  const view = await packages(h);
  expect(view.offer).toMatchObject({ packageVersion: "2.5.0", source: "builtin", tag: null });
  expect(view.reason).toEqual({ code: "manifest.update_interface", data: { minimum: "10.0.0", running: "9.9.9" } });
});

test("a stored manifest the interface can run is offered over the built-in entry, with no reason", async () => {
  await publish("v2.6.0", sampleManifest({ sequence: 9, minimumUiVersion: "9.0.0" }));
  const h = open();
  await refresh(h);
  const view = await packages(h);
  expect(view.offer).toMatchObject({ packageVersion: "2.6.0", source: "downloaded" });
  expect(view.reason).toBeNull();
});

test("when no manifest is one the interface can run, nothing is offered and the newest one's minimum is named", async () => {
  await publish("v3.0.0", sampleManifest({ sequence: 9, minimumUiVersion: "10.0.0" }));
  const h = open({ manifest: { uiVersion: "0.0.1" } });
  await refresh(h);
  const view = await packages(h);
  expect(view.offer).toBeNull();
  expect(view.reason).toEqual({ code: "manifest.update_interface", data: { minimum: "10.0.0", running: "0.0.1" } });
});

test("a running version that cannot be read offers no manifest at all", async () => {
  await publish("v2.6.0", sampleManifest({ sequence: 9 }));
  const h = open({ manifest: { uiVersion: "development" } });
  await refresh(h);
  const view = await packages(h);
  expect(view.offer).toBeNull();
  expect(view.reason).toEqual({ code: "manifest.update_interface", data: { minimum: "0.1.0", running: "development" } });
});

test("a manifest for exactly the running interface is offered", async () => {
  await publish("v2.6.0", sampleManifest({ sequence: 9, minimumUiVersion: "9.9.9" }));
  const h = open();
  await refresh(h);
  expect((await packages(h)).offer?.packageVersion).toBe("2.6.0");
});

// Discovery against the fake release server follows the redirect and reports the tag.

test("discovery follows the latest redirect, reports the tag and asks for nothing else", async () => {
  await publish("v2.6.0", sampleManifest());
  const h = open();
  const { result, view } = await refresh(h);
  expect(result).toEqual({ ok: true, tag: "v2.6.0", replaced: true });
  expect(view.offer?.tag).toBe("v2.6.0");
  expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
    `GET ${LATEST}`,
    "GET /releases/download/v2.6.0/manifest.json",
    "GET /releases/download/v2.6.0/manifest.json.sig",
  ]);
});

test("the manifest and its signature may come from a file store behind another redirect", async () => {
  await publish("v2.6.0", sampleManifest());
  const manifest = fake.files.get("/releases/download/v2.6.0/manifest.json") as Uint8Array;
  const signature = fake.files.get("/releases/download/v2.6.0/manifest.json.sig") as Uint8Array;
  fake.files.set("/store/m", manifest);
  fake.files.set("/store/s", signature);
  fake.redirects.set("/releases/download/v2.6.0/manifest.json", "/store/m");
  fake.redirects.set("/releases/download/v2.6.0/manifest.json.sig", "/store/s");
  const h = open();
  expect((await refresh(h)).result).toEqual({ ok: true, tag: "v2.6.0", replaced: true });
});

test("a redirect that does not lead to a release tag is a failed fetch", async () => {
  fake.redirects.set(LATEST, "/somewhere/else");
  const h = open();
  expect((await refresh(h)).result).toMatchObject({ ok: false, error: { code: "manifest.fetch_failed" } });
});

test("a reply that is not a redirect is a failed fetch", async () => {
  fake.files.set(LATEST, manifestBytes(sampleManifest()));
  const h = open();
  expect((await refresh(h)).result).toEqual({ ok: false, error: { code: "manifest.fetch_failed", data: { step: "discover", status: 200 } } });
});

// With update checks off, no request is made to the fake release server until the operator asks.

test("with no answer yet, or with checks off, nothing is requested until the operator asks", async () => {
  await publish("v2.6.0", sampleManifest());
  const h = open({ updateCheckMs: 15 });
  expect((await packages(h)).updateCheck).toBeNull();
  h.clock.now += 3 * DAY_MS;
  await Bun.sleep(150);
  expect(fake.requests).toEqual([]);

  expect(((await (await put(h, "/api/settings/update-check", { value: "never" })).json()) as PackagesView).updateCheck).toBe("never");
  h.clock.now += 3 * DAY_MS;
  await Bun.sleep(150);
  expect(fake.requests).toEqual([]);

  const { result, view } = await refresh(h);
  expect(result.ok).toBe(true);
  expect(latestRequests()).toBe(1);
  expect(view.lastCheck).toEqual({ at: new Date(h.clock.now).toISOString(), problem: null });
});

test("with daily checks, one check is made once a day has passed", async () => {
  await publish("v2.6.0", sampleManifest());
  const h = open({ updateCheckMs: 15 });
  h.settings.set("updates.lastCheck", { at: new Date(h.clock.now).toISOString(), problem: null });
  expect((await (await put(h, "/api/settings/update-check", { value: "daily" })).json() as PackagesView).updateCheck).toBe("daily");

  h.clock.now += DAY_MS - 60_000;
  await Bun.sleep(150);
  expect(latestRequests()).toBe(0);

  h.clock.now += 120_000;
  await eventually(async () => latestRequests() === 1);
  await Bun.sleep(150);
  expect(latestRequests()).toBe(1);
  expect((await packages(h)).offer?.source).toBe("downloaded");

  h.clock.now += DAY_MS + 1000;
  await eventually(async () => latestRequests() === 2);
});

test("with daily checks and no check yet, the first one is made at once", async () => {
  await publish("v2.6.0", sampleManifest());
  const h = open({ updateCheckMs: 15 });
  h.settings.set("updates.check", "daily");
  await eventually(async () => latestRequests() === 1);
});

test("a failed daily check is kept and shown, and is tried again after an hour", async () => {
  const h = open({ updateCheckMs: 15 });
  h.settings.set("updates.check", "daily");
  await eventually(async () => latestRequests() === 1);
  await Bun.sleep(150);
  expect(latestRequests()).toBe(1);
  expect((await packages(h)).lastCheck?.problem?.code).toBe("manifest.fetch_failed");

  h.clock.now += HOUR_MS - 60_000;
  await Bun.sleep(150);
  expect(latestRequests()).toBe(1);

  h.clock.now += 120_000;
  await eventually(async () => latestRequests() === 2);
  await Bun.sleep(150);
  expect(latestRequests()).toBe(2);
});

test("after a successful check the next one waits a day, even when an hour has passed", async () => {
  await publish("v2.6.0", sampleManifest());
  const h = open({ updateCheckMs: 15 });
  h.settings.set("updates.check", "daily");
  await eventually(async () => latestRequests() === 1);
  await Bun.sleep(100);
  expect(h.settings.get("updates.lastSuccess")).toBe(new Date(h.clock.now).toISOString());

  h.clock.now += 2 * HOUR_MS;
  await Bun.sleep(150);
  expect(latestRequests()).toBe(1);
  h.clock.now += DAY_MS;
  await eventually(async () => latestRequests() === 2);
});

test("a day after an earlier success, a failure is retried after an hour and the success time is kept", async () => {
  const h = open({ updateCheckMs: 15 });
  const success = new Date(h.clock.now - DAY_MS - 1000).toISOString();
  h.settings.set("updates.lastSuccess", success);
  h.settings.set("updates.check", "daily");
  await eventually(async () => latestRequests() === 1);
  await Bun.sleep(100);
  expect(h.settings.get("updates.lastSuccess")).toBe(success);
});

test("a last check that lies in the future, because the clock moved back, counts as due", async () => {
  await publish("v2.6.0", sampleManifest());
  const h = open({ updateCheckMs: 15 });
  const future = new Date(h.clock.now + 3 * DAY_MS).toISOString();
  h.settings.set("updates.lastCheck", { at: future, problem: null });
  h.settings.set("updates.lastSuccess", future);
  h.settings.set("updates.check", "daily");
  await eventually(async () => latestRequests() === 1);
});

test("stopping the checks cancels a look that is in flight at once", async () => {
  let signal: AbortSignal | undefined;
  const h = open({
    updateCheckMs: 15,
    manifest: {
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    },
  });
  h.settings.set("updates.check", "daily");
  await eventually(async () => signal !== undefined);
  const started = Date.now();
  await h.updateChecks.stop();
  expect(Date.now() - started).toBeLessThan(2000);
  expect(signal?.aborted).toBe(true);
  // A look that was cancelled is not a failed look: nothing is recorded, so it runs again at the next start.
  expect(h.settings.get("updates.lastCheck")).toBeNull();
});

test("the update check answer must be daily or never", async () => {
  const h = open();
  for (const value of ["weekly", null, 1, undefined]) {
    const response = await put(h, "/api/settings/update-check", { value });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "api.invalid_body", data: {} } });
  }
  expect(h.settings.get("updates.check")).toBeNull();
});

test("the answer is kept across a restart", async () => {
  folder = mkdtempSync(join(os.tmpdir(), "aidm-ui-manifest-"));
  const first = open({ dataFolder: folder });
  await put(first, "/api/settings/update-check", { value: "never" });
  await first.stop();
  harness = undefined;
  expect((await packages(open({ dataFolder: folder }))).updateCheck).toBe("never");
});

test("two asks at once share one run", async () => {
  await publish("v2.6.0", sampleManifest());
  const h = open();
  const results = await Promise.all([h.manifests.refresh(), h.manifests.refresh()]);
  expect(results[0]).toEqual(results[1]);
  expect(latestRequests()).toBe(1);
});

