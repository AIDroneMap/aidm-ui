import { afterAll, beforeAll, expect, test } from "bun:test";
import { setApiBase } from "./api.ts";
import { pageEntry, pageIsStale, readServerBuild } from "./version.ts";

let server: ReturnType<typeof Bun.serve>;
let answer: () => Response = () => Response.json({ app: "aidm-ui", version: "0.2.0", instance: "abc" });

beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => (new URL(request.url).pathname === "/api/health" ? answer() : new Response("no", { status: 404 })) });
  setApiBase(`http://127.0.0.1:${server.port}`);
});

afterAll(() => {
  server.stop(true);
  setApiBase("");
});

test("a page is stale when the server's version is known and different", () => {
  expect(pageIsStale({ version: "0.1.0", entry: null }, { version: "0.2.0", entry: null })).toBe(true);
  expect(pageIsStale({ version: "0.1.0", entry: null }, { version: "0.1.0", entry: null })).toBe(false);
  expect(pageIsStale({ version: "0.1.0", entry: null }, null)).toBe(false);
});

test("the page reads the server's version and entry script from the health route", async () => {
  expect(await readServerBuild()).toEqual({ version: "0.2.0", entry: null });
  answer = () => Response.json({ app: "aidm-ui", version: "0.2.0", instance: "abc", entry: "/assets/index-abc.js" });
  expect(await readServerBuild()).toEqual({ version: "0.2.0", entry: "/assets/index-abc.js" });
});

test("the page finds its own entry script in its index.html", () => {
  const doc = { querySelector: (selector: string) => (selector.includes("module") ? { getAttribute: () => "/assets/index-abc.js" } : null) };
  expect(pageEntry(doc as unknown as Document)).toBe("/assets/index-abc.js");
  expect(pageEntry(undefined)).toBeNull();
});

test("a server that does not answer, or answers in another shape, is not a new version", async () => {
  answer = () => new Response("<html>oops</html>", { status: 500 });
  expect(await readServerBuild()).toBeNull();
  answer = () => Response.json({ app: "aidm-ui" });
  expect(await readServerBuild()).toBeNull();
  answer = () => Response.json({ version: 7 });
  expect(await readServerBuild()).toBeNull();
});

test("a server that cannot be reached is not a new version", async () => {
  setApiBase("http://127.0.0.1:1");
  expect(await readServerBuild()).toBeNull();
  setApiBase(`http://127.0.0.1:${server.port}`);
});
