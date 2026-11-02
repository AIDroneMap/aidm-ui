import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Theme = "light" | "dark";
type Pair = [foreground: string, background: string, minimum: number];

const TEXT = 4.5;
const NON_TEXT = 3;

/**
 * Every colour pair the components put on screen. Text pairs need 4.5:1
 * (WCAG 2.2 AA, 1.4.3); control borders and the focus ring need 3:1 (1.4.11).
 */
const PAIRS: Pair[] = [
  ...["surface-0", "surface-1", "surface-2"].flatMap((surface): Pair[] => [
    ["text-1", surface, TEXT],
    ["text-2", surface, TEXT],
    ["text-3", surface, TEXT],
    ["accent", surface, TEXT],
    ["border-2", surface, NON_TEXT],
  ]),
  ["text-1", "accent-soft", TEXT],
  ["accent", "accent-soft", TEXT],
  ["on-accent", "accent", TEXT],
  ["ok", "surface-0", TEXT],
  ["ok", "surface-1", TEXT],
  ["ok", "ok-soft", TEXT],
  ["warn", "surface-0", TEXT],
  ["warn", "warn-soft", TEXT],
  ["danger", "surface-0", TEXT],
  ["danger", "surface-1", TEXT],
  ["danger", "danger-soft", TEXT],
  ["on-danger", "danger", TEXT],
  ["info", "surface-0", TEXT],
  ["info", "info-soft", TEXT],
  ["running", "surface-0", TEXT],
  ["running", "surface-1", TEXT],
  ["running", "running-soft", TEXT],
];

/** Tokens that carry no information: the hairlines between rows. The shadow colour has an alpha channel and is no pair either. */
const DECORATIVE = ["border-1"];

function themeColours(css: string): Map<string, Record<Theme, string>> {
  return new Map([...css.matchAll(/--([\w-]+):\s*light-dark\((#[\da-f]{6}),\s*(#[\da-f]{6})\)/gi)]
    .map((match) => [match[1]!, { light: match[2]!, dark: match[3]! }]));
}

function luminance(hex: string): number {
  const [red, green, blue] = hex.slice(1).match(/../g)!
    .map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

function contrastFailures(colours: Map<string, Record<Theme, string>>, pairs: Pair[]): string[] {
  const failures: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    for (const [foreground, background, minimum] of pairs) {
      const front = colours.get(foreground)?.[theme];
      const back = colours.get(background)?.[theme];
      if (!front || !back) { failures.push(`${theme}: ${foreground} on ${background} is not a token`); continue; }
      const ratio = contrast(front, back);
      if (ratio < minimum) failures.push(`${theme}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
    }
  }
  return failures;
}

const colours = themeColours(readFileSync(new URL("../tokens.css", import.meta.url), "utf8"));

test("every colour pair meets AA contrast in the light and the dark theme", () => {
  expect(colours.size).toBeGreaterThan(20);
  expect(contrastFailures(colours, PAIRS)).toEqual([]);
});

test("every colour token is checked in a pair or named as decorative", () => {
  const checked = new Set([...PAIRS.flatMap(([foreground, background]) => [foreground, background]), ...DECORATIVE]);
  expect([...colours.keys()].filter((name) => !checked.has(name))).toEqual([]);
});

test("the contrast check fails a pair below its minimum and a missing token", () => {
  const sample = new Map([["grey", { light: "#777777", dark: "#777777" }], ["white", { light: "#ffffff", dark: "#000000" }]]);
  expect(contrastFailures(sample, [["grey", "white", TEXT]])).toEqual(["light: grey on white is 4.48:1, needs 4.5:1"]);
  expect(contrastFailures(sample, [["grey", "nothing", NON_TEXT]])).toEqual(["light: grey on nothing is not a token", "dark: grey on nothing is not a token"]);
});
