import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreeBytes, freeBytes } from "./disk.ts";

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

function denied(code: string): Error {
  return Object.assign(new Error(code), { code });
}

test("a folder the operator cannot read gives the free space of the nearest parent that can be read", () => {
  const asked: string[] = [];
  const check = createFreeBytes((path) => {
    asked.push(path);
    if (path.startsWith("/var/lib/docker")) throw denied("EACCES");
    return { bavail: 1000, bsize: 4096 };
  });
  expect(check("/var/lib/docker/overlay2")).toBe(4_096_000);
  expect(asked).toEqual(["/var/lib/docker/overlay2", "/var/lib/docker", "/var/lib"]);
});

test("a folder that does not exist and a path through a file are measured on the nearest parent", () => {
  const readable = new Set(["/data"]);
  const check = createFreeBytes((path) => {
    if (!readable.has(path)) throw denied(path === "/data/a/b" ? "ENOTDIR" : "ENOENT");
    return { bavail: 10n, bsize: 512n };
  });
  expect(check("/data/a/b/c")).toBe(5120);
});

test("when even the root cannot be read the error is not hidden", () => {
  const check = createFreeBytes(() => {
    throw denied("EIO");
  });
  expect(() => check("/var/lib/docker")).toThrow("EIO");
});
