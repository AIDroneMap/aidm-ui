import { expect, test } from "bun:test";
import { FakeTaskApi } from "../../test-support/fake-task-api.ts";
import { isTaskNotFound, TaskClient } from "./task-client.ts";

test("restart uses the documented command, replaces options and reuses images", async () => {
  const api = new FakeTaskApi(); await api.start();
  try {
    const client = new TaskClient({ address: api.address, token: api.token });
    const created = await client.createTask("Flight", [{ name: "orthophoto-resolution", value: 6 }]);
    if (!created.ok) throw new Error("Creation failed");
    const { uuid } = created.value;
    await client.uploadImage(uuid, "photo.jpg", new Blob(["synthetic"]));
    await client.commitTask(uuid);
    api.setTask(uuid, { statusCode: 30, output: ["Old log"] });
    expect(await client.restartTask(uuid, [{ name: "orthophoto-resolution", value: 8 }])).toEqual({ ok: true, value: undefined });
    expect(api.tasks.get(uuid)).toMatchObject({ options: [{ name: "orthophoto-resolution", value: 8 }], images: ["photo.jpg"], statusCode: 10, output: [] });
    expect(api.uploads).toHaveLength(1);
    expect(api.requests.some(request => request.method === "POST" && request.path === "/task/restart")).toBe(true);
    api.tasks.delete(uuid);
    const missing = await client.restartTask(uuid, []);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(isTaskNotFound(missing.failure)).toBe(true);
    api.token = "changed";
    const denied = await client.restartTask(uuid, []);
    if (denied.ok) throw new Error("Wrong token accepted");
    expect(isTaskNotFound(denied.failure)).toBe(false);
  } finally { await api.stop(); }
});
