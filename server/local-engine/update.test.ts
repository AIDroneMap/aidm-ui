import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ApiError } from "../../shared/api-error.ts";
import type { LocalEngineView } from "../../shared/api-types.ts";
import { FakeFileServer } from "../../test-support/fake-file-server.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import { generateSigner, sampleManifest, signedRelease, type TestSigner } from "../../test-support/signed-manifest.ts";
import { ACCEPTED_KEYS } from "../manifest/keys.ts";
import type { Manifest } from "../manifest/schema.ts";
import { CONTAINER_NAME } from "../packages/container-package.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";

const REPOSITORY = "ghcr.io/aidronemap/aidm-api";
const IMAGES = {
  "2.5.0": `${REPOSITORY}@sha256:a58c2a633f0f7c1df2a1a441321b1404bad98ece8896ef01ca9b18dfeb2e035e`,
  "2.6.0": `${REPOSITORY}@sha256:${"6".repeat(64)}`,
  "2.7.0": `${REPOSITORY}@sha256:${"7".repeat(64)}`,
};
const VERSION_OF_IMAGE = new Map(Object.entries(IMAGES).map(([version, image]) => [image, version]));
const SIZES = { "2.6.0": 6_000, "2.7.0": 7_000 };
const LATEST = "/releases/latest/download/manifest.json";

let fake: FakeFileServer;
let signer: TestSigner;
let harness: Harness | undefined;

beforeEach(async () => {
  fake = new FakeFileServer();
  await fake.start();
  signer = await generateSigner();
});

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  await fake.stop();
});

/** A runtime whose engines report the version of their image. */
function runtimeOf(options: ConstructorParameters<typeof FakeRuntime>[0] = {}): FakeRuntime {
  return new FakeRuntime({ versionOf: (image) => VERSION_OF_IMAGE.get(image) ?? "2.5.0", ...options });
}

function start(options: { runtime?: FakeRuntime; timeoutMs?: number } = {}): Harness {
  const runtime = options.runtime ?? runtimeOf();
  harness = openHarness({
    enginePollMs: 50,
    runPollMs: 30,
    runtimes: { podman: runtime },
    updateReadyTimeoutMs: options.timeoutMs ?? 3000,
    // The test key and the real list, because the built-in entry is signed by the real list's key.
    manifest: { releasesUrl: fake.url("/releases"), keys: [signer.key, ...ACCEPTED_KEYS], fetch: (url, init) => fetch(url, init) },
  });
  return harness;
}

function release(version: "2.6.0" | "2.7.0", sequence: number, overrides: Partial<Manifest> = {}): Manifest {
  const digest = IMAGES[version].slice(IMAGES[version].indexOf("@") + 1);
  return sampleManifest({
    sequence,
    packageVersion: version,
    variants: {
      "linux-amd64-cpu": { kind: "container", image: REPOSITORY, digest, size: SIZES[version], gpu: false },
    },
    ...overrides,
  });
}

async function publish(manifest: Manifest, by: TestSigner = signer): Promise<void> {
  const { bytes, signature } = await signedRelease(by, manifest);
  const tag = `v${manifest.packageVersion}`;
  fake.files.set(`/releases/download/${tag}/manifest.json`, bytes);
  fake.files.set(`/releases/download/${tag}/manifest.json.sig`, signature);
  fake.redirects.set(LATEST, `/releases/download/${tag}/manifest.json`);
}

function send(h: Harness, method: string, path: string): Promise<Response> {
  return fetch(`${h.base}${path}`, { method });
}

const localView = async (h: Harness) => (await (await send(h, "GET", "/api/local-engine")).json()) as LocalEngineView;

async function errorOf(response: Response): Promise<ApiError> {
  return ((await response.json()) as { error: ApiError }).error;
}

async function installAndWaitReady(h: Harness): Promise<void> {
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");
}

/** Publishes a release and asks for it, the way the operator's check does. */
async function offer(h: Harness, manifest: Manifest): Promise<void> {
  await publish(manifest);
  const response = await send(h, "POST", "/api/packages/refresh");
  expect(((await response.json()) as { result: { ok: boolean } }).result.ok).toBe(true);
}

async function runningVersion(h: Harness): Promise<string | undefined> {
  const view = await localView(h);
  const list = (await (await send(h, "GET", "/api/engines")).json()) as Array<{ kind: string; state: string; info: { version: string } | null }>;
  const local = list.find((engine) => engine.kind === "local");
  return view.state === "ready" && local?.state === "ready" ? local.info?.version : undefined;
}

async function updateTo(h: Harness, version: string): Promise<void> {
  expect((await send(h, "POST", "/api/local-engine/update")).status).toBe(202);
  await untilCurrent(h, version);
}

async function untilCurrent(h: Harness, version: string): Promise<void> {
  await eventually(async () => (await localView(h)).installed?.packageVersion === version && (await localView(h)).update.applying === null);
  await eventually(async () => (await runningVersion(h)) === version);
}

/** A task the fake engine reports as processing, and a run that follows it. */
function runOnEngine(h: Harness, runtime: FakeRuntime): { runId: number; uuid: string } {
  const engine = runtime.engine(CONTAINER_NAME);
  const engineRow = h.engineStore.local();
  const projectId = h.runs.builtinProjectId("sample");
  if (engine === undefined || engineRow === null || projectId === null) throw new Error("There is no engine to run on.");
  const uuid = "00000000-0000-4000-8000-0000000000aa";
  engine.tasks.set(uuid, {
    uuid,
    name: "sample",
    options: [],
    images: ["a.jpg"],
    committed: true,
    statusCode: 20,
    progress: 30,
    processingTime: 5000,
    errorMessage: null,
    output: [],
    results: null,
  });
  const run = h.runs.create({ projectId, engineId: engineRow.id, options: [] });
  h.runs.update(run.id, { taskUuid: uuid, state: "processing" });
  h.tracker.follow(run.id);
  return { runId: run.id, uuid };
}

// Criterion: a newer signed manifest on the fake release server produces an update offer; an older or badly signed one does not.

test("a newer signed manifest produces an update offer with its version and size", async () => {
  const h = start();
  await installAndWaitReady(h);
  expect((await localView(h)).update).toEqual({ available: null, previous: null, blockedBy: null, applying: null });

  await offer(h, release("2.6.0", 2));
  expect((await localView(h)).update).toEqual({
    available: { packageVersion: "2.6.0", size: SIZES["2.6.0"] },
    previous: null,
    blockedBy: null,
    applying: null,
  });
});

test("an offer that arrives while the page is open reaches it through the live view", async () => {
  const h = start();
  await installAndWaitReady(h);
  const seen: LocalEngineView[] = [];
  const unsubscribe = h.localEngine.subscribe((view) => seen.push(view));
  await offer(h, release("2.6.0", 2));
  await eventually(async () => seen.some((view) => view.update.available?.packageVersion === "2.6.0"));
  unsubscribe();
});

test("a manifest with a lower sequence is not used, so it offers nothing, however new its version says it is", async () => {
  const h = start();
  await installAndWaitReady(h);
  await offer(h, release("2.7.0", 3));
  await publish(release("2.6.0", 2, { packageVersion: "2.9.0" }));
  const refreshed = (await (await send(h, "POST", "/api/packages/refresh")).json()) as { result: { ok: boolean; error?: ApiError } };
  expect(refreshed.result.error?.code).toBe("manifest.older_sequence");
  expect((await localView(h)).update.available).toEqual({ packageVersion: "2.7.0", size: SIZES["2.7.0"] });
});

test("a manifest signed with a key that is not accepted offers nothing", async () => {
  const h = start();
  await installAndWaitReady(h);
  const stranger = await generateSigner("stranger");
  await publish(release("2.6.0", 2), stranger);
  const refreshed = (await (await send(h, "POST", "/api/packages/refresh")).json()) as { result: { ok: boolean; error?: ApiError } };
  expect(refreshed.result.error?.code).toBe("manifest.signature_invalid");
  expect((await localView(h)).update.available).toBeNull();
});

test("a release that is not newer than the installed one, or that needs a newer interface, offers nothing", async () => {
  const h = start();
  await installAndWaitReady(h);
  await offer(h, release("2.6.0", 2, { packageVersion: "2.5.0" }));
  expect((await localView(h)).update.available).toBeNull();
  await offer(h, release("2.7.0", 3, { minimumUiVersion: "99.0.0" }));
  expect((await localView(h)).update.available).toBeNull();
});

test("the daily check finds the release when the setting is daily, and there is no network call when it is never", async () => {
  const h = start();
  await installAndWaitReady(h);
  await publish(release("2.6.0", 2));

  h.settings.set("updates.check", "never");
  await h.updateChecks.tick();
  expect(fake.requests).toEqual([]);
  expect((await localView(h)).update.available).toBeNull();

  h.settings.set("updates.check", "daily");
  await h.updateChecks.tick();
  await eventually(async () => (await localView(h)).update.available?.packageVersion === "2.6.0");
});

// Criterion: with a run processing, "Update" is disabled with a message code.

test("with a run processing on the local engine, Update is refused and the view says why", async () => {
  const runtime = runtimeOf();
  const h = start({ runtime });
  await installAndWaitReady(h);
  await offer(h, release("2.6.0", 2));
  const { runId, uuid } = runOnEngine(h, runtime);

  const blockedBy: ApiError = { code: "update.run_in_progress", data: {} };
  await eventually(async () => (await localView(h)).update.blockedBy?.code === "update.run_in_progress");
  expect((await localView(h)).update.blockedBy).toEqual(blockedBy);

  const refused = await send(h, "POST", "/api/local-engine/update");
  expect(refused.status).toBe(409);
  expect(await errorOf(refused)).toEqual(blockedBy);
  expect(runtime.pulls).toEqual([IMAGES["2.5.0"]]);
  expect(runtime.stops).toEqual([]);

  // The way back is refused for the same reason.
  expect(await errorOf(await send(h, "POST", "/api/local-engine/rollback"))).toEqual(blockedBy);

  // A finished run lets go.
  runtime.engine(CONTAINER_NAME)?.setTask(uuid, { statusCode: 40, processingTime: 9000 });
  await eventually(async () => h.runs.get(runId)?.state === "completed");
  expect((await localView(h)).update.blockedBy).toBeNull();
});

test("Update is refused while the engine is switched off, and with nothing to update to", async () => {
  const h = start();
  await installAndWaitReady(h);
  expect(await errorOf(await send(h, "POST", "/api/local-engine/update"))).toEqual({
    code: "install.not_offered",
    data: { reason: null },
  });
  await offer(h, release("2.6.0", 2));
  await fetch(`${h.base}/api/local-engine/enabled`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  expect((await localView(h)).update.blockedBy).toEqual({ code: "update.engine_off", data: {} });
  expect(await errorOf(await send(h, "POST", "/api/local-engine/update"))).toEqual({ code: "update.engine_off", data: {} });
});

// Criterion: a successful update marks the new version current and keeps the old one.

test("a successful update marks the new version current and keeps the old one as the previous", async () => {
  const runtime = runtimeOf();
  const h = start({ runtime });
  await installAndWaitReady(h);
  const token = h.engineStore.local()?.token;
  const mountsBefore = runtime.starts[0]?.spec.mounts;
  await offer(h, release("2.6.0", 2));

  const accepted = await send(h, "POST", "/api/local-engine/update");
  expect(accepted.status).toBe(202);
  await untilCurrent(h, "2.6.0");

  const view = await localView(h);
  expect(view.installed?.packageVersion).toBe("2.6.0");
  expect(view.update).toEqual({ available: null, previous: { packageVersion: "2.5.0" }, blockedBy: null, applying: null });
  expect(view.problem).toBeNull();
  expect(h.settings.get("local.package")?.container.digest).toBe(`sha256:${"6".repeat(64)}`);
  expect(h.settings.get("local.previous")?.packageVersion).toBe("2.5.0");
  expect(h.engineStore.local()?.installedVersion).toBe("2.6.0");

  // The new image was pulled by digest, the old one stays, and the engine runs the new one on the same data folder and token.
  expect(runtime.pulls).toEqual([IMAGES["2.5.0"], IMAGES["2.6.0"]]);
  expect(runtime.removedImages).toEqual([]);
  expect(runtime.images.has(IMAGES["2.5.0"])).toBe(true);
  expect(runtime.starts).toHaveLength(2);
  expect(runtime.starts[1]?.spec.image).toBe(IMAGES["2.6.0"]);
  expect(runtime.starts[1]?.spec.mounts).toEqual(mountsBefore);
  expect(h.engineStore.local()?.token).toBe(token);
  expect(runtime.stops).toEqual([CONTAINER_NAME]);
});

test("while the update runs, the view shows its progress like an install, and the engine is not restarted behind its back", async () => {
  const runtime = runtimeOf();
  const h = start({ runtime });
  await installAndWaitReady(h);
  await offer(h, release("2.6.0", 2));
  const seen: LocalEngineView[] = [];
  h.localEngine.subscribe((view) => seen.push(view));

  await updateTo(h, "2.6.0");
  const phases = seen.map((view) => view.update.applying?.phase).filter((phase) => phase !== undefined);
  expect(phases[0]).toBe("pulling");
  expect(phases).toContain("starting");
  expect(seen.find((view) => view.update.applying?.phase === "pulling")?.update.applying?.size).toBe(SIZES["2.6.0"]);
  // A restart after the stop would be a second start of the old image.
  expect(runtime.starts.map((started) => started.spec.image)).toEqual([IMAGES["2.5.0"], IMAGES["2.6.0"]]);
  expect(h.logs.filter((line) => line.includes("Starting it again"))).toEqual([]);
});

test("an update that cannot be downloaded changes nothing and says why", async () => {
  const runtime = runtimeOf();
  const h = start({ runtime });
  await installAndWaitReady(h);
  await offer(h, release("2.6.0", 2));
  runtime.failNextPulls(5);

  expect((await send(h, "POST", "/api/local-engine/update")).status).toBe(202);
  await eventually(async () => (await localView(h)).problem?.code === "install.pull_failed");
  const view = await localView(h);
  expect(view.update.applying).toBeNull();
  expect(view.installed?.packageVersion).toBe("2.5.0");
  expect(runtime.stops).toEqual([]);
  expect(view.state).toBe("ready");
});

// Criterion: a new version that never becomes ready is rolled back automatically and the failure is reported.

test("a new version that never becomes ready is rolled back by itself and the failure is reported", async () => {
  const runtime = runtimeOf({ silent: (image) => image === IMAGES["2.6.0"] });
  const h = start({ runtime, timeoutMs: 600 });
  await installAndWaitReady(h);
  await offer(h, release("2.6.0", 2));

  expect((await send(h, "POST", "/api/local-engine/update")).status).toBe(202);
  await eventually(async () => (await localView(h)).problem?.code === "update.failed_rolled_back");
  await eventually(async () => (await runningVersion(h)) === "2.5.0");

  const view = await localView(h);
  expect(view.problem).toEqual({ code: "update.failed_rolled_back", data: { version: "2.6.0" } });
  expect(view.installed?.packageVersion).toBe("2.5.0");
  expect(view.update.applying).toBeNull();
  expect(view.update.previous).toBeNull();
  // The offer stands, since the operator may try again.
  expect(view.update.available?.packageVersion).toBe("2.6.0");
  expect(h.settings.get("local.package")?.packageVersion).toBe("2.5.0");
  expect(h.engineStore.local()?.installedVersion).toBe("2.5.0");

  // The failed container is gone and the previous version runs again, on its own image. The failed image goes too.
  expect(runtime.starts.map((started) => started.spec.image)).toEqual([IMAGES["2.5.0"], IMAGES["2.6.0"], IMAGES["2.5.0"]]);
  expect(runtime.removedImages).toEqual([IMAGES["2.6.0"]]);
  expect(runtime.images.has(IMAGES["2.5.0"])).toBe(true);
  expect(runtime.engine(CONTAINER_NAME)?.info.version).toBe("2.5.0");
});

test("a new version that answers with another version than the manifest names is rolled back", async () => {
  const runtime = runtimeOf({ versionOf: () => "2.5.0" });
  const h = start({ runtime, timeoutMs: 600 });
  await installAndWaitReady(h);
  await offer(h, release("2.6.0", 2));

  expect((await send(h, "POST", "/api/local-engine/update")).status).toBe(202);
  await eventually(async () => (await localView(h)).problem?.code === "update.failed_rolled_back");
  expect((await localView(h)).installed?.packageVersion).toBe("2.5.0");
});

// Criterion: after two successful updates, only the current and the previous version remain.

test("after two successful updates only the current and the previous image remain, and the removal of the oldest is recorded", async () => {
  const runtime = runtimeOf();
  const h = start({ runtime });
  await installAndWaitReady(h);

  await offer(h, release("2.6.0", 2));
  await updateTo(h, "2.6.0");
  expect(runtime.removedImages).toEqual([]);

  await offer(h, release("2.7.0", 3));
  await updateTo(h, "2.7.0");

  const view = await localView(h);
  expect(view.installed?.packageVersion).toBe("2.7.0");
  expect(view.update.previous).toEqual({ packageVersion: "2.6.0" });
  expect(runtime.removedImages).toEqual([IMAGES["2.5.0"]]);
  expect([...runtime.images].sort()).toEqual([IMAGES["2.6.0"], IMAGES["2.7.0"]].sort());
  expect(h.settings.get("local.previous")?.packageVersion).toBe("2.6.0");
});

// Criterion: manual rollback starts the previous version and marks it current.

test("a manual rollback starts the previous version and marks it current, keeping the other as the previous", async () => {
  const runtime = runtimeOf();
  const h = start({ runtime });
  await installAndWaitReady(h);
  await offer(h, release("2.6.0", 2));
  await updateTo(h, "2.6.0");

  expect((await send(h, "POST", "/api/local-engine/rollback")).status).toBe(202);
  await eventually(async () => (await localView(h)).installed?.packageVersion === "2.5.0" && (await localView(h)).update.applying === null);
  await eventually(async () => (await runningVersion(h)) === "2.5.0");

  const view = await localView(h);
  expect(view.update.previous).toEqual({ packageVersion: "2.6.0" });
  expect(view.update.available).toEqual({ packageVersion: "2.6.0", size: SIZES["2.6.0"] });
  expect(view.problem).toBeNull();
  expect(h.engineStore.local()?.installedVersion).toBe("2.5.0");
  expect(runtime.starts.map((started) => started.spec.image)).toEqual([IMAGES["2.5.0"], IMAGES["2.6.0"], IMAGES["2.5.0"]]);
  expect(runtime.removedImages).toEqual([]);
});

test("after a rollback the operator can go forward again, and no image that stays is removed", async () => {
  const runtime = runtimeOf();
  const h = start({ runtime });
  await installAndWaitReady(h);
  await offer(h, release("2.6.0", 2));
  await updateTo(h, "2.6.0");
  expect((await send(h, "POST", "/api/local-engine/rollback")).status).toBe(202);
  await eventually(async () => (await localView(h)).installed?.packageVersion === "2.5.0" && (await runningVersion(h)) === "2.5.0");

  await updateTo(h, "2.6.0");
  expect((await localView(h)).update.previous).toEqual({ packageVersion: "2.5.0" });
  expect(runtime.removedImages).toEqual([]);
  expect(runtime.images.has(IMAGES["2.5.0"])).toBe(true);
  expect(runtime.images.has(IMAGES["2.6.0"])).toBe(true);
});

test("a rollback is refused when there is no previous version", async () => {
  const h = start();
  await installAndWaitReady(h);
  expect((await localView(h)).update.previous).toBeNull();
  const refused = await send(h, "POST", "/api/local-engine/rollback");
  expect(refused.status).toBe(409);
  expect(await errorOf(refused)).toEqual({ code: "update.no_previous", data: {} });
});

test("a rollback that does not become ready puts back what was running and reports it", async () => {
  const runtime = runtimeOf();
  const h = start({ runtime, timeoutMs: 600 });
  await installAndWaitReady(h);
  await offer(h, release("2.6.0", 2));
  await updateTo(h, "2.6.0");
  runtime.silent = (image) => image === IMAGES["2.5.0"];

  expect((await send(h, "POST", "/api/local-engine/rollback")).status).toBe(202);
  await eventually(async () => (await localView(h)).problem?.code === "update.rollback_failed");
  await eventually(async () => (await runningVersion(h)) === "2.6.0");

  const view = await localView(h);
  expect(view.problem).toEqual({ code: "update.rollback_failed", data: { version: "2.5.0" } });
  expect(view.installed?.packageVersion).toBe("2.6.0");
  expect(view.update.previous).toEqual({ packageVersion: "2.5.0" });
  expect(runtime.removedImages).toEqual([]);
  expect(runtime.images.has(IMAGES["2.5.0"])).toBe(true);
});

test("the engine log follows the new container after an update", async () => {
  const runtime = runtimeOf();
  const h = start({ runtime });
  await installAndWaitReady(h);
  await offer(h, release("2.6.0", 2));
  await updateTo(h, "2.6.0");
  runtime.emitLog(CONTAINER_NAME, "hello from the new version");
  await eventually(async () => h.localEngine.logs.lines().includes("hello from the new version"));
});
