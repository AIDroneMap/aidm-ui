import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Records source content and write-related metadata, excluding access times. */
export async function folderSnapshot(root: string) {
  const entries: Array<{ name: string; mode: string; size: string; modified: string; changed: string; sha256: string | null }> = [];
  async function walk(name: string): Promise<void> {
    const path = join(root, name), info = await lstat(path, { bigint: true });
    entries.push({ name, mode: String(info.mode), size: String(info.size), modified: String(info.mtimeNs), changed: String(info.ctimeNs), sha256: info.isFile() ? createHash("sha256").update(await readFile(path)).digest("hex") : null });
    if (info.isDirectory()) for (const child of (await readdir(path)).sort()) await walk(name ? join(name, child) : child);
  }
  await walk("");
  return entries;
}
