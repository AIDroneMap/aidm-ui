import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RECORDED = join(import.meta.dir, "..", "..", "test-support", "recorded");

const files = readdirSync(RECORDED, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name !== "README.md")
  .map((entry) => join(entry.parentPath, entry.name));

test("the recorded outputs hold no host name, user name, home folder, identifier or public address", () => {
  expect(files.length).toBeGreaterThan(20);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/\/(home|Users)\/(?!operator\b)/);
    expect(text).not.toContain("7591704b22ff");
    expect(text).not.toMatch(/"Name":"ci"/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-(?!000000000000)[0-9a-f]{12}/);
    for (const address of text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []) {
      expect(address).toMatch(/^(192\.0\.2\.|127\.)/);
    }
  }
});
