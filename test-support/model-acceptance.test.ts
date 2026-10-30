import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveAsset } from "../server/http/static-assets.ts";
import { withSecurityHeaders } from "../server/http/security-headers.ts";
import { texturedGlb } from "./textured-glb.ts";
import { assertArchivedModel, modelAcceptanceAssets } from "./model-acceptance.ts";

test("accepts a textured model and rejects an invalid GLB", async () => {
  const folder = await mkdtemp(join(tmpdir(), "model-assets-"));
  let invalid = false;
  const assets = await modelAcceptanceAssets(folder);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/runs/77/outputs/glb") return withSecurityHeaders(new Response(invalid ? new Uint8Array([103, 108, 84, 70, 10]) : texturedGlb()));
    return withSecurityHeaders(serveAsset(assets, path) ?? new Response(null, { status: 404 }));
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const result = await assertArchivedModel(base, 77);
    expect(result.outputRequests).toBeGreaterThan(0);
    expect(result.coloredPixels).toBeGreaterThan(0);
    expect(result.externalRequests).toEqual([]);
    invalid = true;
    await expect(assertArchivedModel(base, 77)).rejects.toThrow("The 3D model could not be opened.");
  } finally {
    server.stop(true);
    await rm(folder, { recursive: true, force: true });
  }
}, 60000);
