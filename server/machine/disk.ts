import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";

export type FreeBytes = (path: string) => number;

/**
 * Bytes free for this user on the file system that holds the path (statfs
 * bavail times bsize). The path may not exist yet: it walks up to the nearest
 * existing parent.
 */
export function freeBytes(path: string): number {
  let folder = path;
  while (!existsSync(folder)) {
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  const stats = statfsSync(folder);
  return Number(stats.bavail) * Number(stats.bsize);
}
