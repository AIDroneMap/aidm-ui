import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ApiError } from "../../shared/api-error.ts";
import type { EngineView, LocalEngineView, RunLogView, RunView } from "../../shared/api-types.ts";
import { DATABASE_FILE } from "../db/database.ts";
import { FakeRuntime } from "../../test-support/fake-runtime.ts";
import type { FakeTask } from "../../test-support/fake-task-api.ts";
import { CONTAINER_NAME } from "../packages/container-package.ts";
import { fail, type ContainerSpec, type RuntimeId } from "../runtimes/runtime.ts";
import { TaskClient } from "../task-api/task-client.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";
import { RESTART_BACKOFF_SECONDS, RESTART_COUNT_RESET_MS, RESTART_MAX_ATTEMPTS } from "./manager.ts";

const open: Harness[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.stop();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function start(options: Parameters<typeof openHarness>[0] = {}): Harness {
  const harness = openHarness({ enginePollMs: 50, runPollMs: 30, ...options });
  open.push(harness);
  return harness;
}

/** A data folder that outlives one harness, so a second harness on it is aidm-ui started again. */
function keptFolder(): string {
  const folder = mkdtempSync(join(os.tmpdir(), "aidm-ui-lifecycle-"));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function send(h: Harness, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${h.base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function getJson<T>(h: Harness, path: string): Promise<T> {
  return (await (await send(h, "GET", path)).json()) as T;
}

const localView = (h: Harness) => getJson<LocalEngineView>(h, "/api/local-engine");
const engineList = (h: Harness) => getJson<EngineView[]>(h, "/api/engines");
const runView = (h: Harness, id: number) => getJson<RunView>(h, `/api/runs/${id}`);
const logView = (h: Harness, id: number) => getJson<RunLogView>(h, `/api/runs/${id}/log?from=0`);

async function errorOf(response: Response): Promise<ApiError> {
  return ((await response.json()) as { error: ApiError }).error;
}

function podman(h: Harness): FakeRuntime {
  return h.runtimes.podman as FakeRuntime;
}

async function installAndWaitReady(h: Harness): Promise<LocalEngineView> {
  expect((await send(h, "POST", "/api/local-engine/install")).status).toBe(202);
  await eventually(async () => (await localView(h)).state === "ready");
  return localView(h);
}

function tokenOf(h: Harness): string {
  const engine = h.engineStore.local();
  if (engine === null) throw new Error("There is no local engine.");
  return engine.token;
}

/** A sleep that records every wait and does not wait. */
function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

/** A sleep that records every wait and holds until the test lets it go. */
function heldSleep() {
  const delays: number[] = [];
  const gates: Array<() => void> = [];
  return {
    delays,
    release: () => gates.splice(0).forEach((open) => open()),
    sleep: (ms: number) => {
      delays.push(ms);
      return new Promise<void>((resolve) => gates.push(resolve));
    },
  };
}

/** Holds a call until the test lets it go. */
function gate() {
  let open: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { held, release: () => open() };
}

/** A fetch that fails while `down.now` is true, the way a task API that does not answer fails. */
function flakyFetch(down: { now: boolean }): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    down.now ? Promise.reject(new Error("no answer")) : fetch(input, init)) as unknown as typeof fetch;
}

/** Reads the local-engine events as they arrive. */
function watchStates(h: Harness) {
  const states: string[] = [];
  const abort = new AbortController();
  const done = (async () => {
    const response = await fetch(`${h.base}/api/local-engine/events`, { signal: abort.signal });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value);
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const data = buffer.slice(0, end).split("\n").find((line) => line.startsWith("data: "));
          buffer = buffer.slice(end + 2);
          if (data === undefined) continue;
          const state = (JSON.parse(data.slice(6)) as LocalEngineView).state;
          if (states[states.length - 1] !== state) states.push(state);
        }
      }
    } catch {
      // Aborted by close().
    }
  })();
  cleanups.push(async () => {
    abort.abort();
    await done;
  });
  return states;
}

/** A task the fake engine reports as processing, and a run that follows it. */
function runOnEngine(h: Harness, overrides: Partial<FakeTask> = {}): { runId: number; uuid: string } {
  const engine = podman(h).engine(CONTAINER_NAME);
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
    ...overrides,
  });
  const run = h.runs.create({ projectId, engineId: engineRow.id, options: [] });
  h.runs.update(run.id, { taskUuid: uuid, state: "queued" });
  h.tracker.follow(run.id);
  return { runId: run.id, uuid };
}

/** Makes every start leave a container that dies at once, so each restart fails the way a broken engine does. */
function breakStarts(h: Harness): () => void {
  const runtime = podman(h);
  const original = runtime.start.bind(runtime);
  runtime.start = async (spec: ContainerSpec) => {
    const started = await original(spec);
    await runtime.kill(spec.name);
    return started;
  };
  return () => {
    runtime.start = original;
  };
}

const SLOW = 10_000;

/** An engine with a task on it shows as busy, so "answering" is ready or busy. */
async function answering(h: Harness): Promise<boolean> {
  const { state } = await localView(h);
  return state === "ready" || state === "busy";
}

// Criterion: stopping and restarting the aidm-ui server while the task API reports a processing run shows the same run, still processing.

test("stopping and restarting aidm-ui while the engine reports a processing run shows the same run, still processing, with no second start and the same token", async () => {
  const folder = keptFolder();
  const runtimes = { podman: new FakeRuntime() };
  const first = start({ dataFolder: folder, runtimes });
  await installAndWaitReady(first);
  const { runId } = runOnEngine(first, { output: ["line one", "line two"] });
  await eventually(async () => (await runView(first, runId)).state === "processing");
  await eventually(async () => (await logView(first, runId)).lines.length === 2);
  const token = tokenOf(first);
  const address = (await engineList(first))[0]?.address;

  await first.stop({ leaveEngines: true });
  expect(runtimes.podman.stops).toEqual([]);

  const second = start({ dataFolder: folder, runtimes });
  await eventually(() => answering(second));
  expect(await runView(second, runId)).toMatchObject({ id: runId, state: "processing", restarted: false });
  await eventually(async () => (await runView(second, runId)).state === "processing");
  expect((await logView(second, runId)).lines).toEqual(["line one", "line two"]);

  expect(runtimes.podman.starts).toHaveLength(1);
  expect(tokenOf(second)).toBe(token);
  expect((await engineList(second))[0]?.address).toBe(address);
  expect(second.localEngine.logs.isFollowing()).toBe(true);
  expect(runtimes.podman.stops).toEqual([]);
});

test("aidm-ui started again finds its container stopped and starts the engine again", async () => {
  const folder = keptFolder();
  const runtimes = { podman: new FakeRuntime() };
  const first = start({ dataFolder: folder, runtimes });
  await installAndWaitReady(first);
  const token = tokenOf(first);
  await first.stop({ leaveEngines: true });
  await runtimes.podman.kill(CONTAINER_NAME);

  const second = start({ dataFolder: folder, runtimes, startingGraceMs: SLOW });
  await eventually(async () => (await localView(second)).state === "ready");
  expect(runtimes.podman.starts).toHaveLength(2);
  expect(tokenOf(second)).toBe(token);
});

test("aidm-ui started again after the container is gone starts a new one", async () => {
  const folder = keptFolder();
  const runtimes = { podman: new FakeRuntime() };
  const first = start({ dataFolder: folder, runtimes });
  await installAndWaitReady(first);
  await first.stop({ leaveEngines: true });
  await runtimes.podman.remove(CONTAINER_NAME);

  const second = start({ dataFolder: folder, runtimes });
  await eventually(async () => (await localView(second)).state === "ready");
  expect(runtimes.podman.starts).toHaveLength(2);
});

// Criterion: killing the container moves the engine to unreachable, then starting and ready after the manager's restart.

test("a killed container moves the engine to unreachable, then starting and ready, and the attempt and the wait can be seen", async () => {
  const waiting = heldSleep();
  const h = start({ sleep: waiting.sleep, startingGraceMs: 0 });
  await installAndWaitReady(h);
  const states = watchStates(h);
  await eventually(async () => states.length > 0);
  expect((await localView(h)).restarts).toBeNull();

  await podman(h).kill(CONTAINER_NAME);
  await eventually(async () => (await localView(h)).restarts !== null);
  const view = await localView(h);
  expect(view.state).toBe("unreachable");
  expect(view.restarts).toMatchObject({ attempts: 1, max: 5 });
  expect(Date.parse(view.restarts?.nextAt ?? "")).toBeGreaterThan(Date.now() + 1000);
  expect(waiting.delays).toEqual([2000]);
  expect(podman(h).starts).toHaveLength(1);
  expect((await engineList(h))[0]?.state).toBe("unreachable");

  waiting.release();
  await eventually(async () => (await localView(h)).state === "ready");
  expect(podman(h).starts).toHaveLength(2);
  expect(states.slice(-4)).toEqual(["ready", "unreachable", "starting", "ready"]);
  expect((await localView(h)).restarts).toBeNull();
  expect((await localView(h)).problem).toBeNull();
  expect(waiting.delays).toEqual([2000]);
});

test("the waits between tries are 2, 4, 8, 16 and 32 seconds", () => {
  expect([...RESTART_BACKOFF_SECONDS]).toEqual([2, 4, 8, 16, 32]);
  expect(RESTART_MAX_ATTEMPTS).toBe(5);
});

test("a restart that reaches ready and stays there for five minutes starts the count again", async () => {
  const waits = recordingSleep();
  const clock = { now: 1_000_000 };
  const h = start({ sleep: waits.sleep, startingGraceMs: 0, localNow: () => clock.now });
  await installAndWaitReady(h);
  for (let round = 1; round <= 3; round++) {
    await podman(h).kill(CONTAINER_NAME);
    await eventually(async () => podman(h).starts.length === round + 1);
    await eventually(async () => (await localView(h)).state === "ready");
    clock.now += RESTART_COUNT_RESET_MS;
  }
  // Each crash waited the first wait, since each restart stayed ready long enough.
  expect(waits.delays).toEqual([2000, 2000, 2000]);
});

test("an engine that dies again soon after every restart is given up on after five tries", async () => {
  const waits = recordingSleep();
  const clock = { now: 1_000_000 };
  const h = start({ sleep: waits.sleep, startingGraceMs: 0, localNow: () => clock.now });
  await installAndWaitReady(h);
  for (let round = 1; round <= RESTART_MAX_ATTEMPTS; round++) {
    await podman(h).kill(CONTAINER_NAME);
    await eventually(async () => podman(h).starts.length === round + 1);
    await eventually(async () => (await localView(h)).state === "ready");
    // Ready, but not for five minutes.
    clock.now += RESTART_COUNT_RESET_MS - 1000;
  }
  await podman(h).kill(CONTAINER_NAME);
  await eventually(async () => (await localView(h)).problem?.code === "local.restart_gave_up", SLOW);
  expect(waits.delays).toEqual([2000, 4000, 8000, 16000, 32000]);
  expect(podman(h).starts).toHaveLength(1 + RESTART_MAX_ATTEMPTS);
  expect(await localView(h)).toMatchObject({ state: "failed", problem: { code: "local.restart_gave_up", data: { attempts: 5 } } });
});

test("a container that runs but does not answer is reported as not answering and is not restarted", async () => {
  const waits = recordingSleep();
  let silent = false;
  const h = start({
    sleep: waits.sleep,
    startingGraceMs: 0,
    clientFor: (endpoint, options) =>
      new TaskClient(endpoint, {
        ...options,
        fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
          silent ? Promise.reject(new Error("no answer")) : fetch(input, init)) as unknown as typeof fetch,
      }),
  });
  await installAndWaitReady(h);
  silent = true;
  await eventually(async () => (await localView(h)).state === "unreachable");
  await Bun.sleep(300);
  expect((await localView(h)).state).toBe("unreachable");
  expect((await localView(h)).restarts).toBeNull();
  expect(waits.delays).toEqual([]);
  expect(podman(h).starts).toHaveLength(1);
  expect(await podman(h).status(CONTAINER_NAME)).toMatchObject({ ok: true, value: { state: "running" } });
});

test("a container that runs but does not answer is looked at once, and again only when the state changes", async () => {
  const down = { now: false };
  const h = start({
    startingGraceMs: 0,
    clientFor: (endpoint, options) => new TaskClient(endpoint, { ...options, fetch: flakyFetch(down) }),
  });
  await installAndWaitReady(h);
  const runtime = podman(h);
  let statusCalls = 0;
  const original = runtime.status.bind(runtime);
  runtime.status = async (name: string) => {
    statusCalls++;
    return original(name);
  };

  down.now = true;
  await eventually(async () => (await localView(h)).state === "unreachable");
  await eventually(async () => statusCalls >= 1);
  // Other changes among the engines are no reason to look again.
  const other = h.engineStore.addRemote({ name: "Barn", address: "", token: "token" });
  for (let change = 1; change <= 3; change++) {
    h.engineStore.update(other.id, { name: `Barn ${change}` });
    await Bun.sleep(150);
  }
  expect(statusCalls).toBe(1);

  down.now = false;
  await eventually(async () => (await localView(h)).state === "ready");
  down.now = true;
  await eventually(async () => statusCalls === 2);
  expect(podman(h).starts).toHaveLength(1);
});

// Criterion: after the attempt cap the engine shows failed with a message code and no further restart is tried until the operator acts.

async function giveUp(h: Harness, waits: ReturnType<typeof recordingSleep>): Promise<() => void> {
  await installAndWaitReady(h);
  const mend = breakStarts(h);
  await podman(h).kill(CONTAINER_NAME);
  await eventually(async () => (await localView(h)).problem?.code === "local.restart_gave_up", SLOW);
  expect(waits.delays).toEqual([2000, 4000, 8000, 16000, 32000]);
  return mend;
}

test("after five tries the engine is failed with local.restart_gave_up, and nothing starts it again by itself", async () => {
  const waits = recordingSleep();
  const h = start({ sleep: waits.sleep, startingGraceMs: 0 });
  await giveUp(h, waits);

  expect(podman(h).starts).toHaveLength(1 + RESTART_MAX_ATTEMPTS);
  const view = await localView(h);
  expect(view).toMatchObject({
    state: "failed",
    restarts: null,
    startAgain: true,
    problem: { code: "local.restart_gave_up", data: { attempts: 5 } },
  });
  expect((await engineList(h))[0]).toMatchObject({ state: "failed", problem: { code: "local.restart_gave_up" } });

  await Bun.sleep(400);
  expect(podman(h).starts).toHaveLength(1 + RESTART_MAX_ATTEMPTS);
  expect((await localView(h)).state).toBe("failed");
  expect(waits.delays).toHaveLength(5);
});

test("a start that is refused every time also ends in local.restart_gave_up after five tries", async () => {
  const waits = recordingSleep();
  const h = start({ sleep: waits.sleep, startingGraceMs: 0 });
  await installAndWaitReady(h);
  let tries = 0;
  podman(h).start = async () => {
    tries++;
    return fail("runtime.start_failed");
  };
  await podman(h).kill(CONTAINER_NAME);
  await eventually(async () => (await localView(h)).problem?.code === "local.restart_gave_up", SLOW);
  expect(tries).toBe(5);
  expect(waits.delays).toEqual([2000, 4000, 8000, 16000, 32000]);
  await Bun.sleep(300);
  expect(tries).toBe(5);
  expect((await localView(h)).state).toBe("failed");
});

test("turning the switch off and on again after the manager gave up starts the engine", async () => {
  const waits = recordingSleep();
  const h = start({ sleep: waits.sleep, startingGraceMs: 0 });
  const mend = await giveUp(h, waits);
  mend();
  const before = podman(h).starts.length;

  expect((await send(h, "PUT", "/api/local-engine/enabled", { enabled: false })).status).toBe(200);
  expect(await localView(h)).toMatchObject({ enabled: false, state: "stopped", problem: null });
  expect(podman(h).starts).toHaveLength(before);
  expect((await send(h, "PUT", "/api/local-engine/enabled", { enabled: true })).status).toBe(200);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(podman(h).starts).toHaveLength(before + 1);
  expect((await localView(h)).problem).toBeNull();
});

test("a start from the operator after the manager gave up brings the engine back, and the count starts again", async () => {
  const waits = recordingSleep();
  const h = start({ sleep: waits.sleep, startingGraceMs: 0 });
  const mend = await giveUp(h, waits);
  mend();
  const before = podman(h).starts.length;

  // The switch is on, so turning it on again does nothing; the button posts a start.
  const response = await send(h, "POST", "/api/local-engine/start");
  expect(response.status).toBe(200);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(podman(h).starts).toHaveLength(before + 1);
  expect((await localView(h)).problem).toBeNull();

  // A new crash is the first of a new count.
  waits.delays.length = 0;
  await podman(h).kill(CONTAINER_NAME);
  await eventually(async () => podman(h).starts.length === before + 2);
  expect(waits.delays).toEqual([2000]);
});

// Criterion: turning the local engine off stops the container; turning it on starts it again.

test("turning the local engine off stops the container and shows stopped; turning it on starts it again", async () => {
  const waits = recordingSleep();
  const h = start({ sleep: waits.sleep, startingGraceMs: 0 });
  await installAndWaitReady(h);
  expect((await localView(h)).enabled).toBe(true);

  const off = await send(h, "PUT", "/api/local-engine/enabled", { enabled: false });
  expect(off.status).toBe(200);
  expect(((await off.json()) as LocalEngineView).enabled).toBe(false);
  expect(podman(h).stops).toEqual([CONTAINER_NAME]);
  expect(await podman(h).status(CONTAINER_NAME)).toMatchObject({ ok: true, value: { state: "stopped" } });
  expect(await localView(h)).toMatchObject({ enabled: false, state: "stopped", restarts: null });
  expect((await engineList(h))[0]).toMatchObject({ kind: "local", state: "stopped" });

  // Stopped on purpose is not a crash.
  await Bun.sleep(300);
  expect(podman(h).starts).toHaveLength(1);
  expect(waits.delays).toEqual([]);
  expect((await localView(h)).state).toBe("stopped");

  const on = await send(h, "PUT", "/api/local-engine/enabled", { enabled: true });
  expect(on.status).toBe(200);
  await eventually(async () => (await localView(h)).state === "ready");
  expect(podman(h).starts).toHaveLength(2);
  expect(await localView(h)).toMatchObject({ enabled: true, restarts: null });
});

test("turning the switch to where it already is changes nothing", async () => {
  const h = start();
  await installAndWaitReady(h);
  expect((await send(h, "PUT", "/api/local-engine/enabled", { enabled: true })).status).toBe(200);
  expect(podman(h).starts).toHaveLength(1);
  expect(podman(h).stops).toEqual([]);
  await send(h, "PUT", "/api/local-engine/enabled", { enabled: false });
  await send(h, "PUT", "/api/local-engine/enabled", { enabled: false });
  expect(podman(h).stops).toEqual([CONTAINER_NAME]);
});

test("the switch is refused with a code when nothing is installed or the body is wrong", async () => {
  const h = start();
  const notInstalled = await send(h, "PUT", "/api/local-engine/enabled", { enabled: false });
  expect(notInstalled.status).toBe(409);
  expect((await errorOf(notInstalled)).code).toBe("local.not_installed");
  expect((await errorOf(await send(h, "POST", "/api/local-engine/start"))).code).toBe("local.not_installed");
  for (const body of [{}, { enabled: "yes" }, { enabled: null }]) {
    const response = await send(h, "PUT", "/api/local-engine/enabled", body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("api.invalid_body");
  }
});

test("with the switch off, starting aidm-ui again starts nothing and the engine shows stopped", async () => {
  const folder = keptFolder();
  const runtimes = { podman: new FakeRuntime() };
  const first = start({ dataFolder: folder, runtimes });
  await installAndWaitReady(first);
  expect((await send(first, "PUT", "/api/local-engine/enabled", { enabled: false })).status).toBe(200);
  await first.stop({ leaveEngines: true });

  const second = start({ dataFolder: folder, runtimes });
  await Bun.sleep(300);
  expect(runtimes.podman.starts).toHaveLength(1);
  expect(await localView(second)).toMatchObject({ enabled: false, state: "stopped" });
  expect((await engineList(second))[0]).toMatchObject({ state: "stopped" });
  expect(await runtimes.podman.status(CONTAINER_NAME)).toMatchObject({ ok: true, value: { state: "stopped" } });

  // Switched on, it starts.
  expect((await send(second, "PUT", "/api/local-engine/enabled", { enabled: true })).status).toBe(200);
  await eventually(async () => (await localView(second)).state === "ready");
  expect(runtimes.podman.starts).toHaveLength(2);
});

test("switching the engine off while a restart waits ends the restart", async () => {
  const waiting = heldSleep();
  const h = start({ sleep: waiting.sleep, startingGraceMs: 0 });
  await installAndWaitReady(h);
  await podman(h).kill(CONTAINER_NAME);
  await eventually(async () => (await localView(h)).restarts !== null);

  expect((await send(h, "PUT", "/api/local-engine/enabled", { enabled: false })).status).toBe(200);
  waiting.release();
  await Bun.sleep(300);
  expect(podman(h).starts).toHaveLength(1);
  expect(await localView(h)).toMatchObject({ state: "stopped", restarts: null });
});

test("closing aidm-ui while a restart waits does not wait for it and does not start the engine", async () => {
  const waiting = heldSleep();
  const h = start({ sleep: waiting.sleep, startingGraceMs: 0 });
  await installAndWaitReady(h);
  await podman(h).kill(CONTAINER_NAME);
  await eventually(async () => (await localView(h)).restarts !== null);
  await h.localEngine.close();
  waiting.release();
  await Bun.sleep(100);
  expect(podman(h).starts).toHaveLength(1);
});

test("turning the engine off while a restart is starting it waits for that start, then stops the container and tries no more", async () => {
  const waits = recordingSleep();
  const h = start({ sleep: waits.sleep, startingGraceMs: 0 });
  await installAndWaitReady(h);
  const runtime = podman(h);
  const original = runtime.start.bind(runtime);
  const startHeld = gate();
  let entered = false;
  runtime.start = async (spec: ContainerSpec) => {
    entered = true;
    await startHeld.held;
    return original(spec);
  };
  await runtime.kill(CONTAINER_NAME);
  await eventually(async () => entered);

  const off = send(h, "PUT", "/api/local-engine/enabled", { enabled: false });
  await Bun.sleep(100);
  startHeld.release();
  const response = await off;
  expect(response.status).toBe(200);
  expect(await localView(h)).toMatchObject({ enabled: false, state: "stopped", restarts: null });
  expect(await runtime.status(CONTAINER_NAME)).toMatchObject({ ok: true, value: { state: "stopped" } });

  await Bun.sleep(300);
  expect(runtime.starts).toHaveLength(2);
  expect(waits.delays).toEqual([2000]);
});

test("an operator action that has to wait for another one is refused with local.busy", async () => {
  const h = start({ startingGraceMs: 0 });
  await installAndWaitReady(h);
  expect((await send(h, "PUT", "/api/local-engine/enabled", { enabled: false })).status).toBe(200);
  const runtime = podman(h);
  const original = runtime.start.bind(runtime);
  const startHeld = gate();
  let entered = false;
  runtime.start = async (spec: ContainerSpec) => {
    entered = true;
    await startHeld.held;
    return original(spec);
  };
  const on = send(h, "PUT", "/api/local-engine/enabled", { enabled: true });
  await eventually(async () => entered);

  for (const [method, path, body] of [
    ["POST", "/api/local-engine/start", undefined],
    ["PUT", "/api/local-engine/enabled", { enabled: false }],
  ] as const) {
    const refused = await send(h, method, path, body);
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).code).toBe("local.busy");
  }
  startHeld.release();
  expect((await on).status).toBe(200);
  await eventually(async () => (await localView(h)).state === "ready");
});

// Criterion: the switch has one source of truth.

test("an install from before the switch existed, with the engine's flag off and no setting, reads as off and is not started", async () => {
  const folder = keptFolder();
  const runtimes = { podman: new FakeRuntime() };
  const first = start({ dataFolder: folder, runtimes });
  await installAndWaitReady(first);
  await first.stop({ leaveEngines: true });
  await runtimes.podman.kill(CONTAINER_NAME);
  const db = new Database(join(folder, DATABASE_FILE));
  db.run("UPDATE engines SET enabled = 0, last_state = 'stopped' WHERE kind = 'local'");
  db.run("DELETE FROM settings WHERE key = 'local.enabled'");
  db.close();

  const second = start({ dataFolder: folder, runtimes });
  await Bun.sleep(300);
  expect(await localView(second)).toMatchObject({ enabled: false, state: "stopped", startAgain: false });
  expect(runtimes.podman.starts).toHaveLength(1);

  // Switched on, the setting and the engine's flag say so together.
  expect((await send(second, "PUT", "/api/local-engine/enabled", { enabled: true })).status).toBe(200);
  await eventually(async () => (await localView(second)).state === "ready");
  expect(await localView(second)).toMatchObject({ enabled: true });
  expect(second.settings.get("local.enabled")).toBe(true);
  expect(second.engineStore.local()?.enabled).toBe(true);
});

// Criterion: a failed engine that is switched on always has a way forward.

test("a start that fails when aidm-ui starts again leaves the engine failed, with a way to start it again", async () => {
  const folder = keptFolder();
  const runtimes = { podman: new FakeRuntime() };
  const first = start({ dataFolder: folder, runtimes });
  await installAndWaitReady(first);
  await first.stop({ leaveEngines: true });
  await runtimes.podman.kill(CONTAINER_NAME);
  const working = runtimes.podman.start.bind(runtimes.podman);
  runtimes.podman.start = async () => fail("runtime.start_failed");

  const second = start({ dataFolder: folder, runtimes });
  await eventually(async () => (await localView(second)).state === "failed");
  expect(await localView(second)).toMatchObject({
    enabled: true,
    startAgain: true,
    problem: { code: "install.start_failed" },
  });

  runtimes.podman.start = working;
  expect((await send(second, "POST", "/api/local-engine/start")).status).toBe(200);
  await eventually(async () => (await localView(second)).state === "ready");
  expect(await localView(second)).toMatchObject({ startAgain: false, problem: null });
});

// Criterion: the manager never passes a restart policy.

test("no start the manager makes carries a restart policy, whether it is the first, a restart or a start after the switch", async () => {
  const waits = recordingSleep();
  for (const id of ["podman", "docker"] as const) {
    const runtime = new FakeRuntime({ id });
    const runtimes: Partial<Record<RuntimeId, FakeRuntime>> = {};
    runtimes[id] = runtime;
    const h = start({ sleep: waits.sleep, startingGraceMs: 0, runtimes });
    await installAndWaitReady(h);
    await runtime.kill(CONTAINER_NAME);
    await eventually(async () => runtime.starts.length === 2);
    await eventually(async () => (await localView(h)).state === "ready");
    await send(h, "PUT", "/api/local-engine/enabled", { enabled: false });
    await send(h, "PUT", "/api/local-engine/enabled", { enabled: true });
    await eventually(async () => runtime.starts.length === 3);

    for (const { argv, spec } of runtime.starts) {
      expect(argv.length).toBeGreaterThan(0);
      expect(argv.some((part) => part.includes("restart"))).toBe(false);
      expect(JSON.stringify(spec)).not.toContain("restart");
    }
    await h.stop();
  }
});

// Criterion: a run whose task went from processing back to queued shows it restarted.

test("a task that goes from processing back to queued marks the run restarted, keeps it queued, and tells the page where the new output begins", async () => {
  const h = start();
  await installAndWaitReady(h);
  const { runId, uuid } = runOnEngine(h, { output: ["old one", "old two", "old three"] });
  await eventually(async () => (await runView(h, runId)).state === "processing");
  await eventually(async () => (await logView(h, runId)).lines.length === 3);
  expect(await runView(h, runId)).toMatchObject({ restarted: false });
  expect((await logView(h, runId)).restartedAtLine).toBeNull();

  // The task API restarted: the task is queued again and its output begins from line 0.
  podman(h).engine(CONTAINER_NAME)?.setTask(uuid, { statusCode: 10, processingTime: -1, progress: 0, output: ["new one"] });
  await eventually(async () => (await runView(h, runId)).restarted);
  expect(await runView(h, runId)).toMatchObject({ state: "queued", restarted: true });
  await eventually(async () => (await logView(h, runId)).lines.length === 4);
  expect(await logView(h, runId)).toMatchObject({
    lines: ["old one", "old two", "old three", "new one"],
    next: 4,
    restartedAtLine: 3,
  });

  // It goes on from there, without repeating lines.
  const engine = podman(h).engine(CONTAINER_NAME);
  engine?.setTask(uuid, { statusCode: 20, processingTime: 1000, output: ["new one", "new two"] });
  await eventually(async () => (await logView(h, runId)).lines.length === 5);
  expect((await logView(h, runId)).lines.slice(3)).toEqual(["new one", "new two"]);
  expect(await runView(h, runId)).toMatchObject({ state: "processing", restarted: true });
});

test("the engine reading its images again (running with a processing time of -1) after processing is a restart too", async () => {
  const h = start();
  await installAndWaitReady(h);
  const { runId, uuid } = runOnEngine(h);
  await eventually(async () => (await runView(h, runId)).state === "processing");
  podman(h).engine(CONTAINER_NAME)?.setTask(uuid, { statusCode: 20, processingTime: -1 });
  await eventually(async () => (await runView(h, runId)).restarted);
  expect(await runView(h, runId)).toMatchObject({ state: "queued", restarted: true });
  expect((await logView(h, runId)).restartedAtLine).toBe(0);
});

test("a run that waited in the queue and then started is not a restart", async () => {
  const h = start();
  await installAndWaitReady(h);
  const { runId, uuid } = runOnEngine(h, { statusCode: 10, processingTime: -1 });
  await eventually(async () => (await runView(h, runId)).state === "queued");
  podman(h).engine(CONTAINER_NAME)?.setTask(uuid, { statusCode: 20, processingTime: 500 });
  await eventually(async () => (await runView(h, runId)).state === "processing");
  expect(await runView(h, runId)).toMatchObject({ restarted: false });
  expect((await logView(h, runId)).restartedAtLine).toBeNull();
});

test("where the new output begins is kept when aidm-ui is started again, and the engine's lines are not saved twice", async () => {
  const folder = keptFolder();
  const runtimes = { podman: new FakeRuntime() };
  const first = start({ dataFolder: folder, runtimes });
  await installAndWaitReady(first);
  const { runId, uuid } = runOnEngine(first, { output: ["old one", "old two"] });
  await eventually(async () => (await logView(first, runId)).lines.length === 2);
  runtimes.podman.engine(CONTAINER_NAME)?.setTask(uuid, { statusCode: 10, processingTime: -1, output: ["new one"] });
  await eventually(async () => (await logView(first, runId)).lines.length === 3);
  await first.stop({ leaveEngines: true });

  const second = start({ dataFolder: folder, runtimes });
  await eventually(() => answering(second));
  await Bun.sleep(200);
  expect(await logView(second, runId)).toMatchObject({ lines: ["old one", "old two", "new one"], restartedAtLine: 2 });
  expect(await runView(second, runId)).toMatchObject({ restarted: true, state: "queued" });

  runtimes.podman.engine(CONTAINER_NAME)?.setTask(uuid, { output: ["new one", "new two"] });
  await eventually(async () => (await logView(second, runId)).lines.length === 4);
  expect((await logView(second, runId)).lines).toEqual(["old one", "old two", "new one", "new two"]);
});

// The real crash path: the run was not told, it only saw the engine go quiet and come back.

test("a task seen processing, then not answering for several polls, then queued again is a restart", async () => {
  const down = { now: false };
  const h = start({ runClientFor: (endpoint) => new TaskClient(endpoint, { fetch: flakyFetch(down) }) });
  await installAndWaitReady(h);
  const { runId, uuid } = runOnEngine(h, { output: ["old one", "old two"] });
  await eventually(async () => (await runView(h, runId)).state === "processing");
  await eventually(async () => (await logView(h, runId)).lines.length === 2);

  down.now = true;
  await eventually(async () => (await runView(h, runId)).state === "engine_unreachable");
  podman(h).engine(CONTAINER_NAME)?.setTask(uuid, { statusCode: 10, processingTime: -1, progress: 0, output: ["new one"] });
  down.now = false;

  await eventually(async () => (await runView(h, runId)).restarted);
  await eventually(async () => (await logView(h, runId)).lines.length === 3);
  expect(await logView(h, runId)).toMatchObject({ lines: ["old one", "old two", "new one"], restartedAtLine: 2 });
  expect(await runView(h, runId)).toMatchObject({ state: "queued", restarted: true, restartedAtLine: 2 });
});

test("a restart the run did not see is found when the task's output is shorter than the lines already received", async () => {
  const h = start();
  await installAndWaitReady(h);
  const { runId, uuid } = runOnEngine(h, { output: ["old one", "old two", "old three"] });
  await eventually(async () => (await logView(h, runId)).lines.length === 3);
  expect(await runView(h, runId)).toMatchObject({ state: "processing", restarted: false });

  // Still processing, with at least as much time as before, but only one line so far.
  podman(h).engine(CONTAINER_NAME)?.setTask(uuid, { output: ["new one"] });
  await eventually(async () => (await runView(h, runId)).restarted);
  await eventually(async () => (await logView(h, runId)).lines.length === 4);
  expect(await logView(h, runId)).toMatchObject({ lines: ["old one", "old two", "old three", "new one"], next: 4, restartedAtLine: 3 });
  expect(await runView(h, runId)).toMatchObject({ state: "processing", restartedAtLine: 3 });

  podman(h).engine(CONTAINER_NAME)?.setTask(uuid, { output: ["new one", "new two"] });
  await eventually(async () => (await logView(h, runId)).lines.length === 5);
  expect((await logView(h, runId)).lines.slice(3)).toEqual(["new one", "new two"]);
});

test("a restart the run did not see is found when the task's processing time went down", async () => {
  const h = start();
  await installAndWaitReady(h);
  const { runId, uuid } = runOnEngine(h, { output: ["old one", "old two", "old three"] });
  await eventually(async () => (await logView(h, runId)).lines.length === 3);

  // More lines than before, so the length alone would not show it.
  podman(h).engine(CONTAINER_NAME)?.setTask(uuid, { processingTime: 100, output: ["a", "b", "c", "d"] });
  await eventually(async () => (await logView(h, runId)).lines.length === 7);
  expect(await logView(h, runId)).toMatchObject({ lines: ["old one", "old two", "old three", "a", "b", "c", "d"], restartedAtLine: 3 });
  expect(await runView(h, runId)).toMatchObject({ restarted: true, restartedAtLine: 3 });
});

test("a second restart moves where the new output begins", async () => {
  const h = start();
  await installAndWaitReady(h);
  const { runId, uuid } = runOnEngine(h, { output: ["old one", "old two", "old three"] });
  await eventually(async () => (await logView(h, runId)).lines.length === 3);
  const engine = podman(h).engine(CONTAINER_NAME);

  engine?.setTask(uuid, { statusCode: 10, processingTime: -1, output: ["new one"] });
  await eventually(async () => (await logView(h, runId)).restartedAtLine === 3);
  engine?.setTask(uuid, { statusCode: 20, processingTime: 1000, output: ["new one", "new two"] });
  await eventually(async () => (await runView(h, runId)).state === "processing");
  await eventually(async () => (await logView(h, runId)).lines.length === 5);

  engine?.setTask(uuid, { statusCode: 10, processingTime: -1, output: ["third one"] });
  await eventually(async () => (await logView(h, runId)).restartedAtLine === 5);
  await eventually(async () => (await logView(h, runId)).lines.length === 6);
  expect((await logView(h, runId)).lines.slice(5)).toEqual(["third one"]);
  expect(await runView(h, runId)).toMatchObject({ restartedAtLine: 5 });
});
