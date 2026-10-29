import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("text color pairs meet AA contrast", () => {
  const css = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
  const colors = Object.fromEntries([...css.matchAll(/--color-([\w-]+):\s*(#[\da-f]{6})/gi)].map((m) => [m[1], m[2]]));
  function luminance(hex: string) {
    const channels = hex.slice(1).match(/../g)!.map((v) => parseInt(v, 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  }
  for (const [foreground, background] of [["text", "surface"], ["text", "muted"], ["text", "badge"], ["warning-marker", "surface"], ["link", "surface"], ["inverse", "primary"], ["text", "disabled"], ["warning-text", "warning"], ["error-text", "error"], ["hint", "surface"], ["success", "surface"], ["warning-text", "surface"], ["error-text", "surface"], ["inverse", "success"], ["inverse", "warning-marker"], ["inverse", "error-text"]]) {
    expect(colors[foreground!]).toBeDefined();
    expect(colors[background!]).toBeDefined();
    const values = [luminance(colors[foreground!]!), luminance(colors[background!]!)].sort((a,b) => b-a);
    expect((values[0]! + 0.05) / (values[1]! + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
});
