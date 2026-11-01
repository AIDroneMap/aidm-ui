// The install of a container package end to end through the real image
// downloader: a signed manifest on the fake release server names an image on
// the fake registry it holds, and a fake runtime loads what was downloaded.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { LocalEngineView } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeRegistry, type AddedImage } from "../../test-support/fake-registry.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { generateSigner, sampleManifest, signedRelease, type TestSigner } from "../../test-support/signed-manifest.ts";
import { imageFolder } from "../images/image-download.ts";
import { ACCEPTED_KEYS } from "../manifest/keys.ts";
import { registryImages } from "../packages/container-package.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

const LATEST = "/releases/latest/download/manifest.json";

/** Bytes that are the same on every run, so a failure can be reproduced. */
function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * seed + (i >> 7)) & 0xff);
}

let fake: FakeFileServer;
let registry: FakeRegistry;
let signer: TestSigner;
let image: AddedImage;
let repository: string;
const harnesses: Harness[] = [];
const folders: string[] = [];

beforeEach(async () => {
  fake = new FakeFileServer();
  registry = new FakeRegistry();
  fake.registry = registry;
  await fake.start();
  signer = await generateSigner();
  image = registry.addImage({
    repository: "aidronemap/aidm-api",
    config: new TextEncoder().encode('{"architecture":"amd64","os":"linux"}'),
    layers: [bytes(120_000, 7), bytes(200_000, 13), bytes(90_000, 29)],
  });
  repository = `${new URL(fake.url("/")).host}/aidronemap/aidm-api`;
  const manifest = sampleManifest({
    packageVersion: "2.6.0",
    variants: { "linux-amd64-cpu": { kind: "container", image: repository, digest: image.digest, size: image.size, gpu: false } },
  });
  const { bytes: body, signature } = await signedRelease(signer, manifest);
  fake.files.set("/releases/download/v2.6.0/manifest.json", body);
  fake.files.set("/releases/download/v2.6.0/manifest.json.sig", signature);
  fake.redirects.set(LATEST, "/releases/download/v2.6.0/manifest.json");
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.stop();
  await fake.stop();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function start(runtime: FakeRuntime, dataFolder?: string): Harness {
  const h = openHarness({
    enginePollMs: 50,
    runtimes: { podman: runtime },
    manifest: { releasesUrl: fake.url("/releases"), keys: [signer.key, ...ACCEPTED_KEYS], fetch: (url, init) => fetch(url, init) },
    images: registryImages,
    imageDownload: { stallMs: 500, idleMs: 200, backoffMs: () => 10, fetch: loopbackOnly },
    ...(dataFolder === undefined ? {} : { dataFolder }),
  });
  harnesses.push(h);
  return h;
}

/** A fetch that reaches the fake servers and nothing else, so a mistake in a test can never download a real image. */
const loopbackOnly = Object.assign(
  (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== "127.0.0.1") return Promise.reject(new Error(`A test tried to reach ${url.host}.`));
    return fetch(input, init);
  },
  { preconnect: fetch.preconnect },
) as typeof fetch;

/** Asks for the newest manifest, as the operator's check does, so the install offers the release on the fake server. */
async function refreshPackages(h: Harness): Promise<void> {
  const response = await fetch(`${h.base}/api/packages/refresh`, { method: "POST" });
  expect(((await response.json()) as { result: { ok: boolean } }).result.ok).toBe(true);
}

async function install(h: Harness): Promise<void> {
  await refreshPackages(h);
  expect((await fetch(`${h.base}/api/local-engine/install`, { method: "POST" })).status).toBe(202);
}

const localView = async (h: Harness) => (await (await fetch(`${h.base}/api/local-engine`)).json()) as LocalEngineView;

/** Every view of the install while it runs, until `done` says stop. */
async function watchInstall(h: Harness, done: (view: LocalEngineView) => boolean, timeoutMs = 10_000): Promise<LocalEngineView[]> {
  const seen: LocalEngineView[] = [];
  await eventually(async () => {
    const view = await localView(h);
    seen.push(view);
    return done(view);
  }, timeoutMs);
  return seen;
}

const pinned = () => ({ repository, digest: image.digest });

test("an install downloads the image from the registry through resets, the runtime loads it, the engine runs from it, and the download goes", async () => {
  // Every blob body is cut after 100 ms, at about 400 kB/s, so the bigger layers break more than once.
  registry.resetEveryMs = 100;
  registry.bytesPerSecond = 400_000;
  const runtime = new FakeRuntime({ versionOf: () => "2.6.0" });
  const h = start(runtime);

  await install(h);
  const seen = await watchInstall(h, (view) => view.state === "ready");

  expect(runtime.loads).toEqual([`${repository}@${image.digest}`]);
  expect(runtime.starts.at(-1)?.spec.image).toBe(`${repository}@${image.digest}`);
  const installed = h.settings.get("local.package");
  expect(installed).toMatchObject({ packageVersion: "2.6.0", imageRef: `${repository}@${image.digest}` });

  // The progress was real bytes against the manifest's total, and it said why it went on.
  const pulling = seen.map((view) => view.install).filter((install) => install?.phase === "pulling");
  expect(pulling.some((install) => (install?.stepReceived ?? 0) > 0 && (install?.stepReceived ?? 0) < image.size)).toBe(true);
  expect(pulling.every((install) => install?.size === image.size)).toBe(true);
  const retried = pulling.find((install) => (install?.retries ?? 0) > 0);
  expect(retried?.lastRetry?.code).toBe("download.connection_interrupted");

  // Every connection asked the registry for a fresh signed address.
  expect(registry.redirects(image.layerDigests[1] ?? "")).toBeGreaterThan(1);
  expect(existsSync(imageFolder(h.dataFolder, pinned()))).toBe(false);
}, 20_000);

test("a download that gets no byte for the stall time ends the install in failed with download.stalled, and keeps what arrived", async () => {
  // The first layer arrives, the second never gets past the registry.
  registry.failNext(image.layerDigests[1] ?? "", 503, 1_000_000);
  const runtime = new FakeRuntime({ versionOf: () => "2.6.0" });
  const h = start(runtime);

  await install(h);
  await watchInstall(h, (view) => view.state === "failed" || view.install?.phase === "failed");

  const view = await localView(h);
  expect(view.problem).toEqual({ code: "install.pull_failed", data: { cause: { code: "download.stalled", data: { seconds: 1 } } } });
  expect(view.installed).toBeNull();
  expect(runtime.loads).toEqual([]);
  const blobs = readdirSync(join(imageFolder(h.dataFolder, pinned()), "blobs", "sha256"));
  expect(blobs).toContain(image.layerDigests[0]?.slice(7) ?? "");
}, 20_000);

test("aidm-ui stopped in the middle of the download and started again continues from the bytes on disk", async () => {
  registry.bytesPerSecond = 200_000;
  const dataFolder = mkdtempSync(join(os.tmpdir(), "aidm-ui-image-install-"));
  folders.push(dataFolder);
  const first = start(new FakeRuntime({ versionOf: () => "2.6.0" }), dataFolder);
  await install(first);
  // Stop once the middle layer has some of its bytes on disk.
  const middle = image.layerDigests[1]?.slice(7) ?? "";
  const part = join(imageFolder(dataFolder, pinned()), "blobs", "sha256", `${middle}.part`);
  await eventually(async () => existsSync(part) && Bun.file(part).size > 20_000, 10_000);
  await first.stop({ leaveEngines: true });
  harnesses.splice(harnesses.indexOf(first), 1);
  const before = registry.requests.length;
  const kept = Bun.file(part).size;

  const second = start(new FakeRuntime({ versionOf: () => "2.6.0" }), dataFolder);
  await install(second);
  await watchInstall(second, (view) => view.state === "ready", 15_000);

  const after = registry.requests.slice(before).filter((request) => request.path === `/signed/${middle}`);
  const from = Number(/^bytes=(\d+)-$/.exec(after[0]?.range ?? "")?.[1]);
  expect(from).toBeGreaterThanOrEqual(kept);
  // The first layer was finished before the stop, so it is not asked for again.
  const firstLayer = image.layerDigests[0]?.slice(7) ?? "";
  expect(registry.requests.slice(before).some((request) => request.path === `/signed/${firstLayer}`)).toBe(false);
}, 30_000);
