import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/** The Results section and the two viewers, whose controls come from web/src/controls/ only. */
const FILES = [
  "../../map/MapCanvas.tsx",
  "../../map/MapView.tsx",
  "../../model/ModelView.tsx",
  "../../model/ModelPanel.tsx",
  "./ResultsSection.tsx",
  "./RunOutputs.tsx",
  "./DeleteResults.tsx",
];

/** The raw form controls a file's markup writes, as `file: <tag`. */
function rawControls(name: string, source: string): string[] {
  return [...source.matchAll(/<(input|select|button)[\s>/]/g)].map((match) => `${name}: <${match[1]}`);
}

test("the Results section and the viewers use the project's controls, never a raw input, select or button", () => {
  expect(FILES.flatMap((file) => rawControls(file, readFileSync(new URL(file, import.meta.url), "utf8")))).toEqual([]);
});

test("the check finds each raw control and ignores the project's", () => {
  const source = '<Button onClick={go}>Go</Button><Checkbox id="a" label="A" /><Select id="b" label="B"><option>1</option></Select><input type="checkbox" /><select>\n</select><button onClick={go}>';
  expect(rawControls("example.tsx", source)).toEqual(["example.tsx: <input", "example.tsx: <select", "example.tsx: <button"]);
});
