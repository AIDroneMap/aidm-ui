import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { TaskClient } from "../task-api/task-client.ts";
import { eventually, openHarness, type Harness } from "../testing/harness.ts";
import type { RunView } from "../../shared/api-types.ts";
import type { RunReviewView } from "../../shared/run-review.ts";
import { FAILURE_LINES } from "../../shared/run-stages.ts";
import type { RunEvent } from "./run-tracker.ts";

let h: Harness, api: FakeTaskApi, folder: string, project: number, engine: number;
const send = (method: string, path: string, body?: unknown) => fetch(h.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const view = async (id: number) => await (await send("GET", `/api/runs/${id}`)).json() as RunView;
const stage = (run: RunView, name: string) => run.stages?.find((item) => item.name === name);

async function queuedRun(): Promise<{ id: number; uuid: string }> {
  const bytes = Buffer.from("synthetic photo"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = `/api/projects/${project}/uploads`;
  const session = await (await send("POST", path, { name: "photo.jpg", sha256, size: bytes.length })).json() as { id: string };
  await fetch(`${h.base}${path}/${session.id}/chunks/0`, { method: "PUT", body: bytes, headers: { "x-chunk-sha256": sha256 } });
  await send("POST", `${path}/${session.id}/complete`);
  const review = await (await send("GET", `/api/projects/${project}/run-review?engineId=${engine}&preset=quick-map`)).json() as RunReviewView;
  const run = await (await send("POST", `/api/projects/${project}/runs`, { engineId: engine, preset: "quick-map", name: "Field run", revision: review.revision })).json() as RunView;
  await eventually(async () => h.runs.get(run.id)?.state === "queued");
  return { id: run.id, uuid: h.runs.get(run.id)!.taskUuid! };
}

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "aidm-run-progress-"));
  api = new FakeTaskApi(); await api.start();
  h = openHarness({ dataFolder: folder, runPollMs: 10 });
  project = h.ctx.projects.create("Field", "").id;
  engine = h.engineStore.addRemote({ name: "Barn engine", address: api.address, token: api.token }).id;
});
afterEach(async () => { await h.stop(); await api.stop(); rmSync(folder, { recursive: true, force: true }); });

test("a queued run lists every stage waiting, with no processing time and no failure", async () => {
  const run = await view((await queuedRun()).id);
  expect(run.processingTime).toBeNull();
  expect(run.failure).toBeNull();
  expect(run.stages?.length).toBe(11);
  expect(run.stages?.every((item) => item.state === "waiting" && item.startedAt === null)).toBe(true);
});

test("the run view carries the stages the log announced, when they were seen, and the engine's processing time", async () => {
  const { id, uuid } = await queuedRun();
  const before = Date.now();
  api.setTask(uuid, { statusCode: 20, processingTime: 5000, progress: 30, output: ["[INFO]    Running dataset stage", "reading photos", "[INFO]    Running opensfm stage"] });
  await eventually(async () => stage(await view(id), "opensfm")?.state === "running");
  const run = await view(id);
  expect(run.processingTime).toBe(5000);
  expect(stage(run, "dataset")?.state).toBe("done");
  expect(stage(run, "openmvs")?.state).toBe("waiting");
  const seen = Date.parse(stage(run, "opensfm")!.startedAt!);
  expect(seen).toBeGreaterThanOrEqual(before - 1000);
  expect(seen).toBeLessThanOrEqual(Date.now());
});

test("listeners hear of a new processing time and of a new stage even when nothing else changed", async () => {
  const { id, uuid } = await queuedRun();
  api.setTask(uuid, { statusCode: 20, processingTime: 1000, progress: 10, output: ["[INFO]    Running dataset stage"] });
  await eventually(async () => (await view(id)).processingTime === 1000);
  const heard: RunView[] = [];
  const stop = h.tracker.subscribe(id, (event: RunEvent) => { if (event.type === "run") heard.push(event.run); });
  try {
    api.setTask(uuid, { processingTime: 3000 });
    await eventually(async () => heard.some((run) => run.processingTime === 3000));
    api.setTask(uuid, { output: ["[INFO]    Running dataset stage", "[INFO]    Running opensfm stage"] });
    await eventually(async () => heard.some((run) => stage(run, "opensfm")?.state === "running"));
  } finally {
    stop();
  }
});

test("a failed run names its stage and the range of its last lines with the first error", async () => {
  const { id, uuid } = await queuedRun();
  const lines = ["[INFO]    Running dataset stage", ...Array.from({ length: 60 }, (_, index) => `line ${index}`), "[INFO]    Running opensfm stage", "matching", "[ERROR]   Not enough memory", "Traceback (most recent call last):", "[INFO]    done"];
  api.setTask(uuid, { statusCode: 20, processingTime: 9000, output: lines });
  await eventually(async () => h.tracker.log(id, 0).next === lines.length);
  api.setTask(uuid, { statusCode: 30, errorMessage: "Process exited with code 1" });
  await eventually(async () => h.runs.get(id)?.state === "failed");
  const run = await view(id);
  expect(run.failure).toEqual({ stage: "opensfm", from: lines.length - FAILURE_LINES, to: lines.length, errorLine: lines.indexOf("[ERROR]   Not enough memory") });
  expect(stage(run, "opensfm")?.state).toBe("failed");
  expect(stage(run, "odm_postprocess")?.state).toBe("skipped");
  expect(run.processingTime).toBe(9000);
});

test("the stage times and the processing time outlive a restart of aidm-ui", async () => {
  const { id, uuid } = await queuedRun();
  api.setTask(uuid, { statusCode: 20, processingTime: 4000, output: ["[INFO]    Running dataset stage", "[INFO]    Running opensfm stage"] });
  await eventually(async () => stage(await view(id), "opensfm")?.state === "running");
  api.setTask(uuid, { statusCode: 40, processingTime: 8000 });
  await eventually(async () => h.runs.get(id)?.state === "completed");
  const before = await view(id);
  await h.stop(); h = openHarness({ dataFolder: folder, runPollMs: 10 });
  const after = await view(id);
  expect(after.processingTime).toBe(8000);
  expect(after.stages).toEqual(before.stages!);
  expect(stage(after, "opensfm")).toMatchObject({ state: "done" });
  expect(stage(after, "opensfm")?.startedAt).not.toBeNull();
});

test("a run saved before the stage times were kept takes its stages from its log, with no times", async () => {
  const { id, uuid } = await queuedRun();
  api.setTask(uuid, { statusCode: 20, processingTime: 4000, output: ["[INFO]    Running dataset stage", "[INFO]    Running opensfm stage"] });
  await eventually(async () => stage(await view(id), "opensfm")?.state === "running");
  api.setTask(uuid, { statusCode: 40 });
  await eventually(async () => h.runs.get(id)?.state === "completed");
  await h.stop();
  const file = join(folder, "runs", String(id), "stages.json");
  expect(existsSync(file)).toBe(true);
  rmSync(file);
  h = openHarness({ dataFolder: folder, runPollMs: 10 });
  const run = await view(id);
  expect(stage(run, "opensfm")).toEqual({ name: "opensfm", state: "done", startedAt: null });
  expect(stage(run, "openmvs")?.state).toBe("skipped");
  expect(run.processingTime).toBeNull();
});

test("after the engine restarts the run, only the stages of its new start count", async () => {
  const { id, uuid } = await queuedRun();
  api.setTask(uuid, { statusCode: 20, processingTime: 9000, output: ["[INFO]    Running dataset stage", "[INFO]    Running opensfm stage"] });
  await eventually(async () => stage(await view(id), "opensfm")?.state === "running");
  // A processing time that goes back is a restart; the engine's output starts again.
  api.setTask(uuid, { processingTime: 1000, output: ["[INFO]    Running dataset stage"] });
  await eventually(async () => (await view(id)).restartedAtLine === 2);
  await eventually(async () => stage(await view(id), "dataset")?.state === "running");
  expect(stage(await view(id), "opensfm")?.state).toBe("waiting");
});

test("a restart forgets the processing time of the attempt before it until the new one reports its own", async () => {
  const { id, uuid } = await queuedRun();
  api.setTask(uuid, { statusCode: 20, processingTime: 9000, output: ["[INFO]    Running dataset stage", "reading"] });
  await eventually(async () => (await view(id)).processingTime === 9000);
  // Queued again with no output: the engine started the task over and has no time for it yet.
  api.setTask(uuid, { statusCode: 10, processingTime: -1, output: [] });
  await eventually(async () => (await view(id)).restartedAtLine === 2);
  expect((await view(id)).processingTime).toBeNull();
  await h.stop(); h = openHarness({ dataFolder: folder, runPollMs: 10 });
  expect((await view(id)).processingTime).toBeNull();
  api.setTask(uuid, { statusCode: 20, processingTime: 2000 });
  await eventually(async () => (await view(id)).processingTime === 2000);
});

test("a restart seen only in the output keeps the time of the info read before it out of the run", async () => {
  // The engine restarts the task between the poll's two requests: the info still shows the old attempt.
  let restartAfterInfo: string | null = null;
  class RestartingClient extends TaskClient {
    override async taskInfo(uuid: string) {
      const answer = await super.taskInfo(uuid);
      if (restartAfterInfo === uuid) {
        restartAfterInfo = null;
        api.setTask(uuid, { statusCode: 10, processingTime: -1, output: [] });
      }
      return answer;
    }
  }
  await h.stop();
  h = openHarness({ dataFolder: folder, runPollMs: 10, runClientFor: (endpoint) => new RestartingClient(endpoint) });
  const { id, uuid } = await queuedRun();
  api.setTask(uuid, { statusCode: 20, processingTime: 9000, output: ["[INFO]    Running dataset stage", "reading"] });
  await eventually(async () => (await view(id)).processingTime === 9000);
  restartAfterInfo = uuid;
  await eventually(async () => (await view(id)).restartedAtLine === 2);
  expect((await view(id)).processingTime).toBeNull();
  await Bun.sleep(100);
  expect((await view(id)).processingTime).toBeNull();
});
