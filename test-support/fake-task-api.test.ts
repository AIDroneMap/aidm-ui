import { afterEach, expect, test } from "bun:test";
import { FakeTaskApi, WRONG_TOKEN_MESSAGE } from "./fake-task-api.ts";

let fake: FakeTaskApi | undefined;

afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

test("the info route answers with the recorded 2.5.0 values when the token is right", async () => {
  fake = new FakeTaskApi();
  await fake.start();
  const response = await fetch(`${fake.address}/info?token=fake-token`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ version: "2.5.0", cpuCores: 24, taskQueueCount: 0, engine: "aidm" });
});

test("a wrong or missing token gets the real error body with HTTP 200", async () => {
  fake = new FakeTaskApi({ token: "right" });
  await fake.start();
  for (const query of ["?token=wrong", ""]) {
    const response = await fetch(`${fake.address}/info${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ error: WRONG_TOKEN_MESSAGE });
  }
});

test("an unknown route is 404 with HTML", async () => {
  fake = new FakeTaskApi();
  await fake.start();
  const response = await fetch(`${fake.address}/nothing?token=fake-token`);
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/html");
});

test("stop refuses connections and restart listens on the same port again", async () => {
  fake = new FakeTaskApi();
  await fake.start();
  const address = fake.address;
  await fake.stop();
  await expect(fetch(`${address}/info?token=fake-token`)).rejects.toThrow();
  await fake.restart();
  expect(fake.address).toBe(address);
  expect((await fetch(`${address}/info?token=fake-token`)).status).toBe(200);
});

test("it records each request with the token it carried", async () => {
  fake = new FakeTaskApi();
  await fake.start();
  await fetch(`${fake.address}/info?token=abc`);
  expect(fake.requests).toEqual([{ method: "GET", path: "/info", token: "abc" }]);
});

test("the info a test changes is what the next request sees", async () => {
  fake = new FakeTaskApi({ info: { version: "2.4.0" } });
  await fake.start();
  fake.info.cpuCores = 8;
  const body = (await (await fetch(`${fake.address}/info?token=fake-token`)).json()) as Record<string, unknown>;
  expect(body.version).toBe("2.4.0");
  expect(body.cpuCores).toBe(8);
});

// The task routes.

async function post(path: string, body: FormData | URLSearchParams, token = "fake-token"): Promise<unknown> {
  const response = await fetch(`${fake?.address}${path}?token=${token}`, { method: "POST", body });
  expect(response.status).toBe(200);
  return response.json();
}

test("every task route checks the token and answers an error with HTTP 200", async () => {
  fake = new FakeTaskApi();
  await fake.start();
  const calls: Array<[string, string]> = [
    ["POST", "/task/new/init"],
    ["POST", "/task/new/upload/x"],
    ["POST", "/task/new/commit/x"],
    ["POST", "/task/cancel"],
    ["POST", "/task/remove"],
    ["GET", "/task/x/info"],
    ["GET", "/task/x/output"],
    ["GET", "/task/x/download/all.zip"],
  ];
  for (const [method, path] of calls) {
    const response = await fetch(`${fake.address}${path}?token=wrong`, { method });
    expect(response.status, path).toBe(200);
    expect(await response.json(), path).toEqual({ error: WRONG_TOKEN_MESSAGE });
  }
});

test("a task is created running while it initialises, then queued by the commit, and counted in the queue", async () => {
  fake = new FakeTaskApi();
  await fake.start();
  const { uuid } = (await post("/task/new/init", new URLSearchParams({ name: "t", options: "[]" }))) as { uuid: string };
  const info = async () => (await (await fetch(`${fake?.address}/task/${uuid}/info?token=fake-token`)).json()) as { status: { code: number }; processingTime: number };
  expect(await info()).toMatchObject({ status: { code: 20 }, processingTime: -1 });
  const queue = async () => ((await (await fetch(`${fake?.address}/info?token=fake-token`)).json()) as { taskQueueCount: number }).taskQueueCount;
  expect(await queue()).toBe(0);

  const form = new FormData();
  form.append("images", new Blob(["abc"]), "one.JPG");
  expect(await post(`/task/new/upload/${uuid}`, form)).toEqual({ success: true });
  expect(await post(`/task/new/commit/${uuid}`, new URLSearchParams())).toEqual({ uuid });
  expect(await info()).toMatchObject({ status: { code: 10 } });
  expect(await queue()).toBe(1);

  fake.setTask(uuid, { statusCode: 40 });
  expect(await queue()).toBe(0);
  expect(await post("/task/cancel", new URLSearchParams({ uuid }))).toEqual({ success: true });
  expect(fake.tasks.get(uuid)?.statusCode).toBe(50);
  expect(await post("/task/remove", new URLSearchParams({ uuid }))).toEqual({ success: true });
  expect(await post("/task/remove", new URLSearchParams({ uuid }))).toEqual({ success: false, error: `${uuid} not found` });
});

test("an upload without a file, and a commit without images, are the engine's errors", async () => {
  fake = new FakeTaskApi();
  await fake.start();
  const { uuid } = (await post("/task/new/init", new URLSearchParams({ name: "t" }))) as { uuid: string };
  expect(await post(`/task/new/commit/${uuid}`, new URLSearchParams())).toEqual({ error: "Need at least 1 file." });
  const empty = new FormData();
  empty.append("name", "x");
  expect(await post(`/task/new/upload/${uuid}`, empty)).toEqual({ error: "Need at least 1 file.", noRetry: true });
});
