/**
 * Where the camera sits when a 3D model opens and on "Reset view". The
 * engine's model has east along x, north along y and height along z. The
 * camera looks from the south, 35 degrees above the horizon, which is how a
 * pilot pictures a site, at the distance where the model's bounding sphere
 * fills 85 percent of the shorter side of the view.
 */

export const FILL = 0.85;
export const ELEVATION_DEGREES = 35;
export const UP: [number, number, number] = [0, 0, 1];

/** The camera distance at which a sphere of this radius fills FILL of the shorter side, for a vertical field of view in degrees and a width to height ratio. */
export function frameDistance(radius: number, verticalFov: number, aspect: number): number {
  const vertical = Math.tan(verticalFov * Math.PI / 360);
  const shorter = Math.min(vertical, vertical * aspect);
  // The sphere's outline is seen at the angle whose sine is radius over distance; its tangent must be FILL of the half view.
  const target = FILL * shorter;
  return radius * Math.sqrt(1 + 1 / (target * target));
}

export function framedPosition(center: [number, number, number], radius: number, verticalFov: number, aspect: number): [number, number, number] {
  const distance = frameDistance(radius, verticalFov, aspect);
  const elevation = ELEVATION_DEGREES * Math.PI / 180;
  return [center[0], center[1] - distance * Math.cos(elevation), center[2] + distance * Math.sin(elevation)];
}
