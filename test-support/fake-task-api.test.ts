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
