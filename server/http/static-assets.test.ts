import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetsFromFolder, serveAsset } from "./static-assets.ts";

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "aidm-ui-assets-"));
  await mkdir(join(folder, "assets"));
  await writeFile(join(folder, "index.html"), "<h1>home</h1>");
  await writeFile(join(folder, "assets", "app-1.js"), "console.log(1)");
  await writeFile(join(folder, "favicon.svg"), "<svg/>");
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

test("the folder is walked recursively into URL paths", async () => {
  const assets = await assetsFromFolder(folder);
  expect([...assets.keys()].sort()).toEqual(["/assets/app-1.js", "/favicon.svg", "/index.html"]);
});

test("a missing folder gives an empty map", async () => {
  const assets = await assetsFromFolder(join(folder, "missing"));
  expect(assets.size).toBe(0);
  expect(serveAsset(assets, "/")).toBeNull();
});

test("an exact match is served", async () => {
  const assets = await assetsFromFolder(folder);
  const response = serveAsset(assets, "/favicon.svg");
  expect(await response?.text()).toBe("<svg/>");
  expect(response?.headers.get("cache-control")).toBeNull();
});

test("files under /assets/ are cached as immutable", async () => {
  const assets = await assetsFromFolder(folder);
  const response = serveAsset(assets, "/assets/app-1.js");
  expect(await response?.text()).toBe("console.log(1)");
  expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
});

test("the root and unknown pages fall back to index.html without caching", async () => {
  const assets = await assetsFromFolder(folder);
  for (const path of ["/", "/projects/7", "/index.html"]) {
    const response = serveAsset(assets, path);
    expect(await response?.text()).toBe("<h1>home</h1>");
    expect(response?.headers.get("cache-control")).toBe("no-cache");
  }
});

test("a missing file under /assets/ is a coded 404, not the page", async () => {
  const assets = await assetsFromFolder(folder);
  const response = serveAsset(assets, "/assets/gone.js");
  expect(response?.status).toBe(404);
  expect(await response?.json()).toEqual({ error: { code: "interface.not_found", data: {} } });
});

test("API paths never fall back to the interface", async () => {
  const assets = await assetsFromFolder(folder);
  expect(serveAsset(assets, "/api/projects")).toBeNull();
});

test("without an index.html nothing is served for pages", async () => {
  await rm(join(folder, "index.html"));
  const assets = await assetsFromFolder(folder);
  expect(serveAsset(assets, "/")).toBeNull();
  expect(serveAsset(assets, "/favicon.svg")).not.toBeNull();
});
