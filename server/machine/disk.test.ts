import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeBytes } from "./disk.ts";

test("free space of a folder that does not exist yet is the space of its nearest existing parent", () => {
  const folder = mkdtempSync(join(tmpdir(), "aidm-disk-"));
  try {
    const here = freeBytes(folder);
    expect(here).toBeGreaterThan(0);
    const deeper = freeBytes(join(folder, "not", "yet", "there"));
    expect(Math.abs(deeper - here)).toBeLessThan(here * 0.5 + 1_000_000_000);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
