import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetsFromFolder, type AssetMap } from "../http/static-assets.ts";
import { LOCK_FILE_NAME, probe, readLock, writeLock } from "./instance.ts";
import { startAidmUi, type StartResult } from "./start.ts";

const VERSION = "7.7.7";

let root: string;
let assets: AssetMap;
let opened: string[];
const running: Array<{ stop(): Promise<void> }> = [];
const holders: Array<{ stop(force?: boolean): unknown }> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aidm-ui-start-"));
  const web = join(root, "web");
  await mkdir(join(web, "assets"), { recursive: true });
  await writeFile(join(web, "index.html"), "<h1>home</h1>");
  await writeFile(join(web, "assets", "app-1.js"), "console.log('app')");
  assets = await assetsFromFolder(web);
  opened = [];
});

afterEach(async () => {
  for (const copy of running.splice(0)) await copy.stop();
  for (const holder of holders.splice(0)) await holder.stop(true);
  await rm(root, { recursive: true, force: true });
});

/** A port with nothing on it, and nothing on the next one either. */
async function freePort(): Promise<number> {
  for (;;) {
    const probeServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = probeServer.port as number;
    await probeServer.stop(true);
    try {
      const next = Bun.serve({ port: port + 1, hostname: "127.0.0.1", fetch: () => new Response() });
      await next.stop(true);
      return port;
    } catch {
      // The next port is taken, try again.
    }
  }
}

/** Another program that answers "hello" on a port. */
function holdPort(port: number): void {
  holders.push(Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("hello") }));
}

function dataFolder(name: string): string {
  return join(root, name);
}

async function start(folderName: string, port: number): Promise<StartResult> {
  const result = await startAidmUi({
    argv: ["--port", String(port), "--data-dir", dataFolder(folderName)],
    env: {},
    platform: process.platform,
    homeDir: root,
    cwd: root,
    assets,
    version: VERSION,
    openBrowser: async (url) => {
      opened.push(url);
    },
    log: () => {},
  });
  if (result.kind === "started") running.push(result);
  return result;
}

function started(result: StartResult) {
  if (result.kind !== "started") throw new Error(`expected started, got ${JSON.stringify(result)}`);
  return result;
}

test("serves the interface on the given port and opens the browser once", async () => {
  const port = await freePort();
  const result = started(await start("a", port));
  const base = `http://127.0.0.1:${port}`;

  expect(result.url).toBe(`${base}/`);
  expect(opened).toEqual([`${base}/`]);

  const home = await fetch(`${base}/`);
  expect(await home.text()).toBe("<h1>home</h1>");
  expect(home.headers.get("content-security-policy")).toContain("default-src 'self'");

  const script = await fetch(`${base}/assets/app-1.js`);
  expect(await script.text()).toBe("console.log('app')");
  expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

  expect(await (await fetch(`${base}/some/page`)).text()).toBe("<h1>home</h1>");
});

test("health names the app, the version and the data folder's instance", async () => {
  const portA = await freePort();
  const a = started(await start("a", portA));
  const first = await probe(a.port);
  expect(first).toMatchObject({ app: "aidm-ui", version: VERSION });

  const portB = await freePort();
  const b = started(await start("b", portB));
  const second = await probe(b.port);
  expect(second?.instance).not.toBe(first?.instance);
});

test("a second start with the same data folder attaches and listens nowhere else", async () => {
  const port = await freePort();
  const first = started(await start("a", port));
  opened = [];

  const second = await start("a", port);
  expect(second).toEqual({ kind: "attached", url: first.url });
  expect(opened).toEqual([first.url]);

  const next = Bun.serve({ port: port + 1, hostname: "127.0.0.1", fetch: () => new Response() });
  await next.stop(true);
});

test("uses the next port when another program holds the first, and records it in the lock", async () => {
  const port = await freePort();
  holdPort(port);
  const result = started(await start("a", port));

  expect(result.port).toBe(port + 1);
  expect(result.url).toBe(`http://127.0.0.1:${port + 1}/`);
  expect(readLock(dataFolder("a"))).toEqual({ pid: process.pid, port: port + 1 });
});

test("a second copy finds the first through the lock file", async () => {
  const port = await freePort();
  holdPort(port);
  const first = started(await start("a", port));
  opened = [];

  const second = await start("a", port);
  expect(second).toEqual({ kind: "attached", url: `http://127.0.0.1:${port + 1}/` });
  expect(opened).toEqual([first.url]);
});

test("a stale lock file is ignored", async () => {
  const child = Bun.spawn(["true"]);
  await child.exited;
  const port = await freePort();
  await mkdir(dataFolder("a"), { recursive: true });
  writeLock(dataFolder("a"), { pid: child.pid, port });

  const result = started(await start("a", port));
  expect(result.port).toBe(port);
  expect(readLock(dataFolder("a"))?.pid).toBe(process.pid);
});

test("a lock file that points at another program is ignored", async () => {
  const port = await freePort();
  holdPort(port);
  await mkdir(dataFolder("a"), { recursive: true });
  writeLock(dataFolder("a"), { pid: process.pid, port });

  const result = started(await start("a", port));
  expect(result.port).toBe(port + 1);
});

test("stop removes the lock file and frees the port", async () => {
  const port = await freePort();
  const result = started(await start("a", port));
  expect(await Bun.file(join(dataFolder("a"), LOCK_FILE_NAME)).exists()).toBe(true);

  await result.stop();

  expect(await Bun.file(join(dataFolder("a"), LOCK_FILE_NAME)).exists()).toBe(false);
  expect(await probe(port)).toBeNull();
  const again = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() });
  await again.stop(true);
});

test("copies with different data folders do not attach to each other", async () => {
  const port = await freePort();
  started(await start("a", port));
  const second = started(await start("b", port));

  expect(second.port).toBe(port + 1);
  expect((await probe(port))?.instance).not.toBe((await probe(port + 1))?.instance);
});

test("an unknown API path is a coded 404", async () => {
  const port = await freePort();
  started(await start("a", port));
  const response = await fetch(`http://127.0.0.1:${port}/api/nothing`);
  expect(response.status).toBe(404);
  expect(await response.text()).toBe(JSON.stringify({ error: { code: "api.not_found", data: {} } }));
});

test("a bad command line fails with a problem and starts nothing", async () => {
  const result = await startAidmUi({
    argv: ["--port", "0"],
    env: {},
    platform: process.platform,
    homeDir: root,
    cwd: root,
    assets,
    version: VERSION,
    openBrowser: async (url) => {
      opened.push(url);
    },
    log: () => {},
  });
  expect(result.kind).toBe("failed");
  expect(opened).toEqual([]);
});

test("fails when every port in the range is taken", async () => {
  const port = await freePort();
  for (let offset = 0; offset < 10; offset++) {
    try {
      holdPort(port + offset);
    } catch {
      // A port in the range is already in use by something else, which also counts.
    }
  }
  const result = await start("a", port);
  expect(result.kind).toBe("failed");
  if (result.kind === "failed") expect(result.problem).toContain(`${port}`);
});

test("the same data folder reached through a symlink attaches", async () => {
  const port = await freePort();
  started(await start("real", port));
  await symlink(dataFolder("real"), dataFolder("link"));
  const second = await start("link", port);
  expect(second.kind).toBe("attached");
});
