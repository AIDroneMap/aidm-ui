import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHarness } from "../testing/harness.ts";

test("saved presets retain exact values across restart, rename and deletion", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aidm-presets-"));
  let h = openHarness({ dataFolder: folder });
  const request = (method: string, path: string, body?: unknown) => fetch(h.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const file = { options: [{ name: "dsm", value: true }, { name: "orthophoto-resolution", value: 8 }], preset: "Vineyard", engineVersion: "0.1.0" };
    const response = await request("POST", "/api/presets", file);
    expect(response.status).toBe(201);
    const saved = await response.json() as typeof file & { id: number };
    expect(saved).toEqual({ id: expect.any(Number), ...file });
    await h.stop(); h = openHarness({ dataFolder: folder });
    expect(await (await request("GET", `/api/presets/${saved.id}`)).json()).toEqual(saved);
    expect(await (await request("GET", "/api/presets")).json()).toEqual({ presets: [{ id: saved.id, preset: "Vineyard", engineVersion: "0.1.0" }], nextOffset: null });
    expect((await request("PUT", `/api/presets/${saved.id}`, { preset: "Field map" })).status).toBe(200);
    expect(await (await request("GET", `/api/presets/${saved.id}`)).json()).toEqual({ ...saved, preset: "Field map" });
    expect((await request("DELETE", `/api/presets/${saved.id}`)).status).toBe(204);
    expect((await request("GET", `/api/presets/${saved.id}`)).status).toBe(404);
    expect(await (await request("GET", "/api/presets")).json()).toEqual({ presets: [], nextOffset: null });
  } finally { await h.stop(); await rm(folder, { recursive: true, force: true }); }
});

test("preset routes reject malformed files, protect built-ins and paginate summaries", async () => {
  const h = openHarness();
  const request = (method: string, path: string, body?: unknown) => fetch(h.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const file = { options: [{ name: "dsm", value: true }], preset: "Map", engineVersion: null };
  try {
    for (const body of [{ ...file, token: "not allowed" }, { ...file, options: [{ name: "dsm", value: {} }] }, { ...file, preset: " " }]) expect((await request("POST", "/api/presets", body)).status).toBe(400);
    const saved = await (await request("POST", "/api/presets", file)).json() as { id: number };
    expect((await request("POST", "/api/presets", file)).status).toBe(409);
    expect((await request("PUT", `/api/presets/${saved.id}`, { preset: "", options: [] })).status).toBe(400);
    for (const method of ["PUT", "DELETE"]) expect((await request(method, "/api/presets/quick-map", { preset: "Changed" })).status).toBe(404);
    for (let i = 0; i < 50; i++) expect((await request("POST", "/api/presets", { ...file, preset: "Map " + i })).status).toBe(201);
    const first = await (await request("GET", "/api/presets")).json() as any;
    expect(first.presets).toHaveLength(50); expect(first.nextOffset).toBe(50);
    expect(first.presets.every((preset: object) => !Object.hasOwn(preset, "options"))).toBe(true);
    const last = await (await request("GET", "/api/presets?offset=50")).json() as any;
    expect(last).toEqual({ presets: [{ id: saved.id, preset: "Map", engineVersion: null }], nextOffset: null });
    expect((await request("GET", "/api/presets?offset=-1")).status).toBe(400);
  } finally { await h.stop(); }
});
