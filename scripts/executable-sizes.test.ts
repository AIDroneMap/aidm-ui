import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sizesOf, sizesTable } from "./executable-sizes.ts";

test("the release notes list every platform's executable with its size in bytes and MiB", () => {
  const folder = mkdtempSync(join(tmpdir(), "aidm-ui-sizes-"));
  try {
    const files: Record<string, number> = {
      "aidm-ui-linux-x64": 1000,
      "aidm-ui-linux-arm64": 2_097_152,
      "aidm-ui-macos-arm64": 3_145_728,
      "aidm-ui-windows-x64.exe": 4096,
    };
    for (const [file, size] of Object.entries(files)) writeFileSync(join(folder, file), new Uint8Array(size));
    expect(sizesTable(sizesOf(folder))).toBe(
      [
        "### Executables",
        "",
        "| Platform | File | Size |",
        "| --- | --- | --- |",
        "| Linux x64 | `aidm-ui-linux-x64` | 1,000 bytes (0.0 MiB) |",
        "| Linux arm64 | `aidm-ui-linux-arm64` | 2,097,152 bytes (2.0 MiB) |",
        "| macOS arm64 (Apple silicon) | `aidm-ui-macos-arm64` | 3,145,728 bytes (3.0 MiB) |",
        "| Windows x64 | `aidm-ui-windows-x64.exe` | 4,096 bytes (0.0 MiB) |",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a missing executable stops the notes instead of leaving its platform out", () => {
  expect(() => sizesTable(new Map([["aidm-ui-linux-x64", 1]]))).toThrow("aidm-ui-linux-arm64 is missing");
});
