/** The speed is the bytes of this last stretch of time. */
export const SPEED_WINDOW_MS = 10_000;

/**
 * Measures a download's speed from the byte counts it reports. Give it the
 * bytes received so far each time; it answers bytes per second over the last
 * ten seconds, or null until a second has passed. A count that goes back (a
 * new download) starts the measure again.
 */
export function speedMeter(now: () => number = Date.now): (received: number) => number | null {
  const samples: Array<{ at: number; received: number }> = [];
  return (received) => {
    const at = now();
    if (samples.length > 0 && received < (samples.at(-1)?.received ?? 0)) samples.length = 0;
    samples.push({ at, received });
    while (samples.length > 2 && at - (samples[1]?.at ?? at) >= SPEED_WINDOW_MS) samples.shift();
    const first = samples[0];
    const span = first === undefined ? 0 : at - first.at;
    return first !== undefined && span >= 1000 ? Math.round(((received - first.received) * 1000) / span) : null;
  };
}
