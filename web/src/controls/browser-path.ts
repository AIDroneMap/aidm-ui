import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function browserPath(): Promise<string> {
  const configured = process.env.CHROME_BIN ?? process.env.CHROMIUM_BIN;
  if (configured) {
    if (await Bun.file(configured).exists()) return configured;
    throw new Error(`Configured browser does not exist: ${configured}`);
  }
  const candidates = [Bun.which("google-chrome"), Bun.which("google-chrome-stable"), Bun.which("chromium"), Bun.which("chromium-browser"), "/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable"];
  const cache = join(process.env.HOME ?? "", ".cache", "ms-playwright");
  for (const dir of await readdir(cache).catch(() => [])) {
    if (dir.startsWith("chromium-")) candidates.push(join(cache, dir, "chrome-linux64", "chrome"));
  }
  for (const path of candidates) if (path && await Bun.file(path).exists()) return path;
  throw new Error("A Chrome or Chromium executable is required for the browser tests. Set CHROME_BIN.");
}
