import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { errorResponse } from "../../shared/api-error.ts";

/**
 * URL path ("/index.html", "/assets/index-abc.js") to a file path, on disk in
 * development or inside the compiled executable ($bunfs) in a release build.
 */
export type AssetMap = ReadonlyMap<string, string>;

const INDEX = "/index.html";

/** Walks a folder recursively. A missing folder gives an empty map. */
export async function assetsFromFolder(folder: string): Promise<AssetMap> {
  const assets = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(folder, { recursive: true, withFileTypes: true });
  } catch {
    return assets;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const relative = file.slice(folder.length).split(/[\\/]+/).filter(Boolean);
    assets.set("/" + relative.join("/"), file);
  }
  return assets;
}

export function serveAsset(assets: AssetMap, urlPath: string): Response | null {
  const exact = assets.get(urlPath);
  if (exact !== undefined) {
    const response = new Response(Bun.file(exact));
    if (urlPath === INDEX) {
      response.headers.set("Cache-Control", "no-cache");
    } else if (urlPath.startsWith("/assets/")) {
      // Build output names carry a content hash, so these files never change.
      response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }
    return response;
  }

  if (urlPath.startsWith("/api/")) return null;
  // A missing script or style must not come back as the page, or the browser
  // would try to run HTML as JavaScript.
  if (urlPath.startsWith("/assets/")) return errorResponse(404, "interface.not_found");

  // Single-page application: the browser router decides what a page shows.
  const index = assets.get(INDEX);
  if (index === undefined) return null;
  const response = new Response(Bun.file(index));
  response.headers.set("Cache-Control", "no-cache");
  return response;
}
