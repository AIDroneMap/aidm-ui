import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pngSize } from "../../scripts/macos-icon.ts";

// Vite copies web/public/ to the root of the build, so these files are served at /favicon.svg and /apple-touch-icon.png.
const web = join(import.meta.dir, "..");
const page = readFileSync(join(web, "index.html"), "utf8");

test("the page links the tab icon and the touch icon, from the interface's own files", () => {
  expect(page).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
  expect(page).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
});

test("the tab icon is the app's icon, unchanged, and the touch icon is a 180 pixel PNG", () => {
  const source = readFileSync(join(web, "..", "assets", "icon", "aidm-ui.svg"), "utf8");
  expect(readFileSync(join(web, "public", "favicon.svg"), "utf8")).toBe(source);
  expect(pngSize(readFileSync(join(web, "public", "apple-touch-icon.png")))).toEqual({ width: 180, height: 180 });
});
