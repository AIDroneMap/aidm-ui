import { expect, test } from "bun:test";
import { ELEVATION_DEGREES, FILL, frameDistance, framedPosition } from "./framing.ts";

/** The share of the shorter side a sphere's outline covers, seen from a distance. */
function shareOfShorterSide(radius: number, distance: number, verticalFov: number, aspect: number): number {
  const half = Math.tan(Math.asin(radius / distance));
  const vertical = Math.tan(verticalFov * Math.PI / 360);
  return half / Math.min(vertical, vertical * aspect);
}

test("the model's bounding sphere fills 85 percent of the shorter side, on a wide or a tall view", () => {
  for (const aspect of [16 / 9, 1, 0.5]) for (const radius of [0.5, 120]) {
    expect(shareOfShorterSide(radius, frameDistance(radius, 45, aspect), 45, aspect)).toBeCloseTo(FILL, 10);
  }
  // A tall view is narrower than high, so the camera stands further back than on a wide one.
  expect(frameDistance(10, 45, 0.5)).toBeGreaterThan(frameDistance(10, 45, 2));
  expect(frameDistance(10, 45, 2)).toBeCloseTo(frameDistance(10, 45, 1), 10);
});

test("the camera looks from the south, 35 degrees above the horizon", () => {
  const center: [number, number, number] = [500, 2000, 30];
  const [x, y, z] = framedPosition(center, 50, 45, 1.5);
  expect(x).toBe(500);
  expect(y).toBeLessThan(2000);
  const ground = 2000 - y, height = z - 30;
  expect(Math.atan2(height, ground) * 180 / Math.PI).toBeCloseTo(ELEVATION_DEGREES, 10);
  expect(Math.hypot(ground, height)).toBeCloseTo(frameDistance(50, 45, 1.5), 10);
});
