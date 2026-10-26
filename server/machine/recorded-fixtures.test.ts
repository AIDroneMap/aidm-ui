import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RECORDED = join(import.meta.dir, "..", "..", "test-support", "recorded");

const files = readdirSync(RECORDED, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name !== "README.md")
  .map((entry) => join(entry.parentPath, entry.name));

/** Only the Docker info names the machine in its top-level "Name"; in an inspect it is the container's. */
const isInfo = (file: string) => /\/info[^/]*$/.test(file);

/** Every key and value of a parsed JSON document, with the depth of the key. */
function entries(value: unknown, depth = 0): Array<{ key: string; value: unknown; depth: number }> {
  if (Array.isArray(value)) return value.flatMap((item) => entries(item, depth));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [{ key, value: inner, depth }, ...entries(inner, depth + 1)]);
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

test("the recorded outputs hold no host name, user name, home folder, identifier or public address", () => {
  expect(files.length).toBeGreaterThan(20);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    expect(text, file).not.toMatch(/\/(home|Users)\/(?!operator\b)/);
    expect(text, file).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-(?!000000000000)[0-9a-f]{12}/);
    for (const address of text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []) {
      expect(address, file).toMatch(/^(192\.0\.2\.|127\.)/);
    }
    for (const { key, value, depth } of entries(parsed(text))) {
      // The machine's own name: "hostname" at any depth, and the top-level "Name" of the Docker info (not of an inspect).
      if (key.toLowerCase() === "hostname" || (key === "Name" && depth === 0 && isInfo(file))) {
        expect(value, `${file} ${key}`).toBe("operator-pc");
        expect(String(value), `${file} ${key}`).not.toMatch(/^[0-9a-f]{12}$/);
      }
    }
  }
});

test("the recorded outputs hold no fingerprint of the machine they were taken on", () => {
  const standard: Record<string, unknown> = {
    NCPU: 8,
    cpus: 8,
    MemTotal: 34359738368,
    memTotal: 34359738368,
    KernelVersion: "6.8.0-generic",
    kernel: "6.8.0-generic",
  };
  let checked = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const { key, value } of entries(parsed(text))) {
      if (key in standard) {
        expect(value, `${file} ${key}`).toBe(standard[key]);
        checked += 1;
      }
    }
    for (const stamp of text.match(/\b20\d\d-\d\d-\d\dT[0-9:.]+(Z|[+-]\d\d:\d\d)?/g) ?? []) {
      expect(stamp, file).toMatch(/^2026-01-01T00:00:00/);
    }
  }
  expect(checked).toBeGreaterThan(10);
});
