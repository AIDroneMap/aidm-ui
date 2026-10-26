import { statfsSync } from "node:fs";
import { dirname } from "node:path";

export type FreeBytes = (path: string) => number;

/** What the check reads from the file system: blocks free to this user and the size of a block. */
export type StatFs = (path: string) => { bavail: number | bigint; bsize: number | bigint };

/**
 * Bytes free for this user on the file system that holds the path (statfs
 * bavail times bsize). The path may not exist yet, or may sit inside a folder
 * the operator cannot enter (a runtime's storage is often mode 0710), so it
 * walks up to the nearest parent that statfs can read.
 */
export function createFreeBytes(read: StatFs = statfsSync): FreeBytes {
  return (path) => {
    let folder = path;
    for (;;) {
      try {
        const stats = read(folder);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch (error) {
        const parent = dirname(folder);
        // Nothing above the root to try.
        if (parent === folder) throw error;
        folder = parent;
      }
    }
  };
}

export const freeBytes: FreeBytes = createFreeBytes();
