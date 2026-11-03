import { expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../package.json";

// A release tag takes its version from package.json. These checks keep the
// changelog ready for that tag: the version has its own dated section, and
// every entry in it says where its evidence is.

const changelog = await Bun.file(join(import.meta.dir, "../CHANGELOG.md")).text();
const headings = changelog.split("\n").filter((line) => line.startsWith("## "));

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATED = new RegExp(`^## (\\S+) \\(([1-9]|[12]\\d|3[01]) (${MONTHS}) (\\d{4})\\)$`);

/** The entries of the section that starts at `heading`, one string each. */
function entries(heading: string): string[] {
  const start = changelog.indexOf(`\n${heading}\n`) + heading.length + 2;
  const next = changelog.indexOf("\n## ", start);
  const section = changelog.slice(start, next === -1 ? undefined : next);
  return section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

test("Unreleased stays the first section, so later changes have a place", () => {
  expect(headings[0]).toBe("## Unreleased");
});

test("the version in package.json has a dated section right after Unreleased", () => {
  const heading = headings[1] ?? "";
  expect(heading).toMatch(DATED);
  expect(DATED.exec(heading)?.[1]).toBe(pkg.version);
});

test("every entry of the version's section names its evidence", () => {
  const heading = headings.find((line) => DATED.exec(line)?.[1] === pkg.version);
  expect(heading).toBeDefined();
  const listed = entries(heading ?? "");
  expect(listed.length).toBeGreaterThan(0);
  for (const entry of listed) expect(entry, entry.slice(0, 80)).toContain("Evidence:");
});
