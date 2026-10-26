export const MAX_FAILED_LOGINS = 5;
export const FAILED_LOGIN_WINDOW_MS = 10 * 60 * 1000;

/** Slows down guessing: five failed logins from one address in ten minutes block it until the window passes. */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly now: () => number) {}

  private recent(address: string): number[] {
    const cutoff = this.now() - FAILED_LOGIN_WINDOW_MS;
    const recent = (this.failures.get(address) ?? []).filter((time) => time > cutoff);
    if (recent.length === 0) this.failures.delete(address);
    else this.failures.set(address, recent);
    return recent;
  }

  isBlocked(address: string): boolean {
    return this.recent(address).length >= MAX_FAILED_LOGINS;
  }

  recordFailure(address: string): void {
    this.failures.set(address, [...this.recent(address), this.now()]);
  }

  recordSuccess(address: string): void {
    this.failures.delete(address);
  }
}
