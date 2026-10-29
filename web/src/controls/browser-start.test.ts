import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startBrowser } from "./browser-start.ts";

test("a browser that exits reports its stderr without waiting for the startup deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-test-"));
  try {
    const executable = join(dir, "browser");
    await writeFile(executable, '#!/bin/sh\nprintf "startup failure\\n" >&2\nexit 7\n', { mode: 0o755 });
    await expect(startBrowser(executable, dir, "about:blank", 1000)).rejects.toThrow("startup failure");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a browser that never starts is stopped at the deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-test-"));
  try {
    const executable = join(dir, "browser");
    await writeFile(executable, '#!/bin/sh\nprintf "waiting\\n" >&2\nexec sleep 30\n', { mode: 0o755 });
    await expect(startBrowser(executable, dir, "about:blank", 200)).rejects.toThrow("waiting");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
