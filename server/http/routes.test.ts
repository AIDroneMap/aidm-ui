import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHarness, TEST_IDENTITY as identity, type Harness } from "../testing/harness.ts";
import { assetsFromFolder } from "./static-assets.ts";

let folder: string;
let harness: Harness | undefined;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "aidm-ui-routes-"));
});

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  await rm(folder, { recursive: true, force: true });
});

async function open(withIndex: boolean): Promise<string> {
  if (withIndex) await writeFile(join(folder, "index.html"), "<h1>home</h1>");
  harness = openHarness({ assets: await assetsFromFolder(folder) });
  return harness.base;
}

test("health answers with the identity", async () => {
  const base = await open(true);
  const response = await fetch(`${base}/api/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(identity);
});

test("an unknown API path is a coded 404", async () => {
  const base = await open(true);
  const response = await fetch(`${base}/api/nothing/here`);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: { code: "api.not_found" } });
});

test("a POST to health is a coded 404 and not the interface", async () => {
  const base = await open(true);
  const response = await fetch(`${base}/api/health`, { method: "POST" });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: { code: "api.not_found" } });
});

test("pages are served from the asset map", async () => {
  const base = await open(true);
  expect(await (await fetch(`${base}/projects/1`)).text()).toBe("<h1>home</h1>");
});

test("without a built interface pages are a coded 404", async () => {
  const base = await open(false);
  const response = await fetch(`${base}/`);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: { code: "interface.not_built" } });
});

test("a non-GET request on a page is a coded 405", async () => {
  const base = await open(true);
  const response = await fetch(`${base}/projects`, { method: "POST" });
  expect(response.status).toBe(405);
  expect(await response.json()).toEqual({ error: { code: "api.method_not_allowed" } });
});

test("every kind of response carries the security headers", async () => {
  const base = await open(true);
  for (const [path, init] of [
    ["/", undefined],
    ["/api/health", undefined],
    ["/api/nope", undefined],
    ["/api/health", { method: "POST" }],
    ["/x", { method: "DELETE" }],
  ] as const) {
    const response = await fetch(`${base}${path}`, init);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  }
});
