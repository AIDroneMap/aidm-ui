/** Failures in a row that are logged one by one before the summaries take over. */
export const UNREACHABLE_LINES_IN_FULL = 3;
/** How often an engine that stays unreachable gets a summary line. */
export const UNREACHABLE_SUMMARY_MS = 60_000;

interface Streak {
  failures: number;
  since: number;
  lastSummary: number;
  lastDetail: string;
}

/**
 * The "Could not reach" lines of the task client, kept readable when an engine
 * stays away. The first three failures in a row are logged in full; after
 * that, one summary a minute says how many failures there were since when and
 * the last error, until the engine answers or the error changes. Every client
 * of an engine shares one streak, by the engine's address, so the monitor's
 * polls and a run's polls of the same engine add up to one summary.
 */
export class UnreachableLines {
  private readonly streaks = new Map<string, Streak>();

  constructor(
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** A call to `where` on the engine at `address` got no answer. */
  failed(address: string, where: string, detail: string): void {
    const now = this.now();
    const streak = this.streaks.get(address) ?? { failures: 0, since: now, lastSummary: now, lastDetail: "" };
    this.streaks.set(address, streak);
    streak.failures += 1;
    const changed = streak.failures > 1 && detail !== streak.lastDetail;
    streak.lastDetail = detail;
    if (streak.failures <= UNREACHABLE_LINES_IN_FULL || changed) {
      streak.lastSummary = now;
      this.log(`Could not reach ${where}: ${detail}`);
      return;
    }
    if (now - streak.lastSummary < UNREACHABLE_SUMMARY_MS) return;
    streak.lastSummary = now;
    this.log(`Still unreachable: ${address}, ${streak.failures} failures since ${new Date(streak.since).toISOString()}, last error ${detail}`);
  }

  /** The engine at `address` answered, so its streak ends. A long one gets a line that says so. */
  answered(address: string): void {
    const streak = this.streaks.get(address);
    if (streak === undefined) return;
    this.streaks.delete(address);
    if (streak.failures > UNREACHABLE_LINES_IN_FULL) {
      this.log(`${address} answers again, after ${streak.failures} failures since ${new Date(streak.since).toISOString()}`);
    }
  }
}
