export const MAX_FAILED_LOGINS = 5;
export const FAILED_LOGIN_WINDOW_MS = 10 * 60 * 1000;

/** Slows down guessing: five wrong logins from one address in ten minutes block it until the window passes. */
export class LoginThrottle {
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly now: () => number) {}

  private recent(address: string): number[] {
    const cutoff = this.now() - FAILED_LOGIN_WINDOW_MS;
    const recent = (this.attempts.get(address) ?? []).filter((time) => time > cutoff);
    if (recent.length === 0) this.attempts.delete(address);
    else this.attempts.set(address, recent);
    return recent;
  }

  /**
   * Checks the limit and counts the attempt in one step with nothing awaited
   * in between, so parallel guesses cannot all pass the check. False means blocked.
   * A right passphrase takes the count back through clear().
   */
  reserve(address: string): boolean {
    const recent = this.recent(address);
    if (recent.length >= MAX_FAILED_LOGINS) return false;
    this.attempts.set(address, [...recent, this.now()]);
    return true;
  }

  clear(address: string): void {
    this.attempts.delete(address);
  }
}
