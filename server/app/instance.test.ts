import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  instanceId,
  isProcessAlive,
  LOCK_FILE_NAME,
  probe,
  readLock,
  removeLock,
  writeLock,
} from "./instance.ts";

let folder: string;
const servers: Array<{ stop(force?: boolean): unknown }> = [];

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "aidm-ui-instance-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  await rm(folder, { recursive: true, force: true });
});

function serve(fetch: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  servers.push(server);
  return server.port as number;
}

test("the instance id is a stable SHA-256 of the folder and differs between folders", () => {
  expect(instanceId("/a/b")).toMatch(/^[0-9a-f]{64}$/);
  expect(instanceId("/a/b")).toBe(instanceId("/a/b"));
  expect(instanceId("/a/b")).not.toBe(instanceId("/a/c"));
});

test("a lock file round trips and is private to the owner", async () => {
  expect(readLock(folder)).toBeNull();
  writeLock(folder, { pid: 42, port: 8823 });
  expect(readLock(folder)).toEqual({ pid: 42, port: 8823 });
  if (process.platform !== "win32") {
    const mode = (await stat(join(folder, LOCK_FILE_NAME))).mode & 0o777;
    expect(mode).toBe(0o600);
  }
});

test("an unreadable lock file reads as no lock", async () => {
  await writeFile(join(folder, LOCK_FILE_NAME), "not json");
  expect(readLock(folder)).toBeNull();
  await writeFile(join(folder, LOCK_FILE_NAME), JSON.stringify({ pid: "x" }));
  expect(readLock(folder)).toBeNull();
});

test("removeLock only removes a lock that holds the given pid", () => {
  writeLock(folder, { pid: 42, port: 1 });
  removeLock(folder, 7);
  expect(readLock(folder)).not.toBeNull();
  removeLock(folder, 42);
  expect(readLock(folder)).toBeNull();
  removeLock(folder, 42);
});

test("this process is alive and a finished one is not", async () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  const child = Bun.spawn(["true"]);
  await child.exited;
  expect(isProcessAlive(child.pid)).toBe(false);
});

test("probe returns the identity of an aidm-ui server", async () => {
  const identity = { app: "aidm-ui", version: "1.2.3", instance: "abc" } as const;
  const port = serve(() => Response.json(identity));
  expect(await probe(port)).toEqual(identity);
});

test("probe returns null for another program, another app or a closed port", async () => {
  expect(await probe(serve(() => new Response("hello")))).toBeNull();
  expect(await probe(serve(() => Response.json({ app: "other", version: "1", instance: "x" })))).toBeNull();
  expect(await probe(serve(() => Response.json({ app: "aidm-ui", version: 1 })))).toBeNull();

  const port = serve(() => new Response("x"));
  await servers.pop()?.stop(true);
  expect(await probe(port)).toBeNull();
});

test("probe gives up on a server that never answers", async () => {
  const port = serve(() => new Promise<Response>(() => {}));
  const started = Date.now();
  expect(await probe(port, 100)).toBeNull();
  expect(Date.now() - started).toBeLessThan(1000);
});
